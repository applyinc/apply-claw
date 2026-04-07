import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";

import YAML from "yaml";

import { runActionScript, runBulkAction, type ActionConfig, type ActionContext, type ActionEvent } from "./action-runner.js";
import { getActiveWorkspaceName, resolveWorkspaceRoot } from "./workspace-service.js";
import {
  discoverDuckDBPaths,
  parseSimpleYaml,
} from "./workspace-discovery-service.js";

const execAsync = promisify(exec);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "tmp", "exports"]);
const VALID_FIELD_TYPES = new Set([
  "text", "number", "email", "phone", "date", "boolean",
  "enum", "tags", "url", "richtext", "file", "action",
]);

type ObjectRow = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  default_view?: string;
  display_field?: string;
};

type FieldRow = {
  id: string;
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  enum_values?: string | null;
  default_value?: string | null;
  related_object_id?: string | null;
  relationship_type?: string | null;
  sort_order?: number;
};

type SavedView = {
  name: string;
  view_type?: string;
  filters?: unknown;
  sort?: unknown[];
  columns?: string[];
  column_widths?: Record<string, number>;
  settings?: Record<string, unknown>;
};

type ViewTypeSettings = Record<string, unknown>;

type ObjectYamlConfig = {
  icon?: string;
  default_view?: string;
  view_settings?: ViewTypeSettings;
  views?: SavedView[];
  active_view?: string;
  [key: string]: unknown;
};

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveDuckdbBin(): string | null {
  const candidates = [
    join(process.env.HOME || "", ".duckdb", "cli", "latest", "duckdb"),
    join(process.env.HOME || "", ".local", "bin", "duckdb"),
    "/opt/homebrew/bin/duckdb",
    "/usr/local/bin/duckdb",
    "/usr/bin/duckdb",
  ];
  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }
  try {
    execSync("which duckdb", { encoding: "utf-8", timeout: 2000 });
    return "duckdb";
  } catch {
    return null;
  }
}

async function duckdbQueryOnFileAsync<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): Promise<T[]> {
  const bin = resolveDuckdbBin();
  if (!bin) return [];
  try {
    const escapedSql = sql.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(`'${bin}' -json '${dbFilePath}' '${escapedSql}'`, {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/sh",
    });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "[]") return [];
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

async function duckdbExecOnFileAsync(dbFilePath: string, sql: string): Promise<boolean> {
  const bin = resolveDuckdbBin();
  if (!bin) return false;
  try {
    const escapedSql = sql.replace(/'/g, "'\\''");
    await execAsync(`'${bin}' '${dbFilePath}' '${escapedSql}'`, {
      encoding: "utf-8",
      timeout: 10_000,
      shell: "/bin/sh",
    });
    return true;
  } catch {
    return false;
  }
}

function parseObjectYaml(content: string): ObjectYamlConfig {
  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ObjectYamlConfig;
  } catch {
    return parseSimpleYaml(content) as ObjectYamlConfig;
  }
}

function readObjectYaml(objectDir: string): ObjectYamlConfig | null {
  const yamlPath = join(objectDir, ".object.yaml");
  if (!existsSync(yamlPath)) return null;
  return parseObjectYaml(readFileSync(yamlPath, "utf-8"));
}

function writeObjectYaml(objectDir: string, config: ObjectYamlConfig): void {
  const yamlPath = join(objectDir, ".object.yaml");
  let existing: ObjectYamlConfig = {};
  if (existsSync(yamlPath)) {
    try {
      existing = parseObjectYaml(readFileSync(yamlPath, "utf-8"));
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...config };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  writeFileSync(yamlPath, YAML.stringify(merged, { indent: 2, lineWidth: 0 }), "utf-8");
}

function findObjectDir(objectName: string): string | null {
  const root = resolveWorkspaceRoot();
  if (!root) return null;
  const direct = join(root, objectName);
  if (existsSync(direct) && existsSync(join(direct, ".object.yaml"))) return direct;

  function search(dir: string, depth: number): string | null {
    if (depth > 4) return null;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const subDir = join(dir, entry.name);
        if (entry.name === objectName && existsSync(join(subDir, ".object.yaml"))) {
          return subDir;
        }
        const found = search(subDir, depth + 1);
        if (found) return found;
      }
    } catch {}
    return null;
  }

  return search(root, 1);
}

async function findDuckDBForObject(objectName: string): Promise<string | null> {
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) return null;
  const sql = `SELECT id FROM objects WHERE name = '${sqlEscape(objectName)}' LIMIT 1`;
  for (const dbPath of dbPaths) {
    const rows = await duckdbQueryOnFileAsync<{ id: string }>(dbPath, sql);
    if (rows.length > 0) return dbPath;
  }
  return null;
}

async function findObjectRecord(objectName: string): Promise<{ dbFile: string; object: ObjectRow } | null> {
  const dbFile = await findDuckDBForObject(objectName);
  if (!dbFile) return null;
  const rows = await duckdbQueryOnFileAsync<ObjectRow>(
    dbFile,
    `SELECT * FROM objects WHERE name = '${sqlEscape(objectName)}' LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return { dbFile, object: rows[0] };
}

function resolveDisplayFieldName(objectRow: ObjectRow, fields: FieldRow[]): string {
  if (objectRow.display_field) return objectRow.display_field;
  const nameField = fields.find((field) => /\bname\b/i.test(field.name) || /\btitle\b/i.test(field.name));
  if (nameField) return nameField.name;
  const textField = fields.find((field) => field.type === "text");
  if (textField) return textField.name;
  return fields[0]?.name ?? "id";
}

async function regeneratePivotView(dbFile: string, objectName: string, objectId: string) {
  const fields = await duckdbQueryOnFileAsync<{ name: string }>(
    dbFile,
    `SELECT name FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND type != 'action' ORDER BY sort_order`,
  );
  if (fields.length === 0) {
    await duckdbExecOnFileAsync(dbFile, `DROP VIEW IF EXISTS v_${objectName}`);
    return;
  }
  const fieldList = fields.map((field) => `'${sqlEscape(field.name)}'`).join(", ");
  await duckdbExecOnFileAsync(
    dbFile,
    `CREATE OR REPLACE VIEW v_${objectName} AS
     PIVOT (
       SELECT e.id as entry_id, e.created_at, e.updated_at,
              f.name as field_name, ef.value
       FROM entries e
       JOIN entry_fields ef ON ef.entry_id = e.id
       JOIN fields f ON f.id = ef.field_id
       WHERE e.object_id = '${sqlEscape(objectId)}'
     ) ON field_name IN (${fieldList}) USING first(value)`,
  );
}

async function updateObjectYamlFields(objectName: string, dbFile: string, objectId: string) {
  const dir = findObjectDir(objectName);
  if (!dir) return;
  const existing = readObjectYaml(dir) ?? {};
  const fields = await duckdbQueryOnFileAsync<{
    name: string;
    type: string;
    required: boolean;
    enum_values: string | null;
    default_value: string | null;
  }>(
    dbFile,
    `SELECT name, type, required, enum_values, default_value FROM fields WHERE object_id = '${sqlEscape(objectId)}' ORDER BY sort_order`,
  );
  const entryCount = await duckdbQueryOnFileAsync<{ cnt: number }>(
    dbFile,
    `SELECT COUNT(*) as cnt FROM entries WHERE object_id = '${sqlEscape(objectId)}'`,
  );
  writeObjectYaml(dir, {
    ...existing,
    entry_count: entryCount[0]?.cnt ?? 0,
    fields: fields.map((field) => {
      const result: Record<string, unknown> = { name: field.name, type: field.type };
      if (field.required) result.required = true;
      if (field.enum_values) {
        try {
          result.enum_values = JSON.parse(field.enum_values);
        } catch {}
      }
      if (field.type === "action" && field.default_value) {
        try {
          result.action_config = JSON.parse(field.default_value);
        } catch {}
      }
      return result;
    }),
  });
}

export async function getObjectViews(objectName: string) {
  const dir = findObjectDir(objectName);
  if (!dir) {
    return { views: [], activeView: undefined, viewSettings: undefined };
  }
  const config = readObjectYaml(dir);
  if (!config) {
    return { views: [], activeView: undefined, viewSettings: undefined };
  }
  return {
    views: config.views ?? [],
    activeView: config.active_view,
    viewSettings: config.view_settings,
  };
}

export async function saveObjectViews(
  objectName: string,
  views: SavedView[],
  activeView?: string,
  viewSettings?: ViewTypeSettings,
) {
  const dir = findObjectDir(objectName);
  if (!dir) return false;
  const patch: ObjectYamlConfig = {
    views: views.length > 0 ? views : undefined,
    active_view: activeView,
    ...(viewSettings ? { view_settings: viewSettings } : {}),
  };
  writeObjectYaml(dir, patch);
  return true;
}

export async function setObjectDisplayField(objectName: string, displayField: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
    return { error: "Invalid object name", status: 400 as const };
  }
  if (!displayField.trim()) {
    return { error: "displayField must be a non-empty string", status: 400 as const };
  }
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  await duckdbExecOnFileAsync(record.dbFile, "ALTER TABLE objects ADD COLUMN IF NOT EXISTS display_field VARCHAR");
  const escapedField = sqlEscape(displayField.trim());
  const fieldCheck = await duckdbQueryOnFileAsync<{ id: string }>(
    record.dbFile,
    `SELECT id FROM fields WHERE object_id = '${sqlEscape(record.object.id)}' AND name = '${escapedField}' LIMIT 1`,
  );
  if (fieldCheck.length === 0) {
    return { error: `Field '${displayField}' not found on object '${objectName}'`, status: 400 as const };
  }
  const ok = await duckdbExecOnFileAsync(
    record.dbFile,
    `UPDATE objects SET display_field = '${escapedField}', updated_at = now() WHERE name = '${sqlEscape(objectName)}'`,
  );
  if (!ok) return { error: "Failed to update display field", status: 500 as const };
  return { data: { ok: true, displayField }, status: 200 as const };
}

export async function reorderObjectFields(objectName: string, fieldOrder: string[]) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) {
    return { error: "fieldOrder must be a non-empty array", status: 400 as const };
  }
  for (let index = 0; index < fieldOrder.length; index += 1) {
    await duckdbExecOnFileAsync(
      record.dbFile,
      `UPDATE fields SET sort_order = ${index} WHERE id = '${sqlEscape(fieldOrder[index])}' AND object_id = '${sqlEscape(record.object.id)}'`,
    );
  }
  return { data: { ok: true }, status: 200 as const };
}

export async function createObjectField(
  objectName: string,
  body: Record<string, unknown>,
) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
    return { error: "Invalid object name", status: 400 as const };
  }
  const fieldName = typeof body.name === "string" ? body.name.trim() : "";
  const fieldType = typeof body.type === "string" ? body.type.trim() : "";
  const enumValues = Array.isArray(body.enum_values) ? body.enum_values as string[] : undefined;
  const required = body.required === true;
  if (!fieldName) return { error: "Field name is required", status: 400 as const };
  if (!fieldType || !VALID_FIELD_TYPES.has(fieldType)) {
    return { error: `Invalid field type. Must be one of: ${[...VALID_FIELD_TYPES].join(", ")}`, status: 400 as const };
  }
  if (fieldType === "enum" && (!enumValues || enumValues.length === 0)) {
    return { error: "enum_values required for enum fields", status: 400 as const };
  }
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const duplicateCheck = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM fields WHERE object_id = '${sqlEscape(record.object.id)}' AND name = '${sqlEscape(fieldName)}'`,
  );
  if ((duplicateCheck[0]?.cnt ?? 0) > 0) {
    return { error: "A field with that name already exists", status: 409 as const };
  }
  const maxOrder = await duckdbQueryOnFileAsync<{ max_order: number }>(
    record.dbFile,
    `SELECT COALESCE(MAX(sort_order), -1) as max_order FROM fields WHERE object_id = '${sqlEscape(record.object.id)}'`,
  );
  const sortOrder = (maxOrder[0]?.max_order ?? -1) + 1;
  const idRows = await duckdbQueryOnFileAsync<{ id: string }>(record.dbFile, "SELECT uuid()::VARCHAR as id");
  const fieldId = idRows[0]?.id;
  if (!fieldId) return { error: "Failed to generate field ID", status: 500 as const };
  const enumSql = fieldType === "enum" && enumValues
    ? `, '${sqlEscape(JSON.stringify(enumValues))}'::JSON`
    : ", NULL";
  const actionConfig = body.action_config;
  const defaultValueSql = fieldType === "action" && actionConfig
    ? `'${sqlEscape(JSON.stringify(actionConfig))}'`
    : "NULL";
  const ok = await duckdbExecOnFileAsync(
    record.dbFile,
    `INSERT INTO fields (id, object_id, name, type, required, sort_order, enum_values, default_value)
     VALUES ('${sqlEscape(fieldId)}', '${sqlEscape(record.object.id)}', '${sqlEscape(fieldName)}', '${sqlEscape(fieldType)}', ${required}, ${sortOrder}${enumSql}, ${defaultValueSql})`,
  );
  if (!ok) return { error: "Failed to create field", status: 500 as const };
  await regeneratePivotView(record.dbFile, objectName, record.object.id);
  await updateObjectYamlFields(objectName, record.dbFile, record.object.id);
  if (fieldType === "action") {
    const objectDir = findObjectDir(objectName);
    if (objectDir) {
      mkdirSync(join(objectDir, ".actions"), { recursive: true });
    }
  }
  return { data: { ok: true, fieldId, name: fieldName, type: fieldType }, status: 201 as const };
}

export async function renameObjectField(objectName: string, fieldId: string, newName: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  if (!newName.trim()) return { error: "Name is required", status: 400 as const };
  const fieldExists = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  if ((fieldExists[0]?.cnt ?? 0) === 0) return { error: "Field not found", status: 404 as const };
  const duplicateCheck = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM fields WHERE object_id = '${sqlEscape(record.object.id)}' AND name = '${sqlEscape(newName.trim())}' AND id != '${sqlEscape(fieldId)}'`,
  );
  if ((duplicateCheck[0]?.cnt ?? 0) > 0) return { error: "A field with that name already exists", status: 409 as const };
  const ok = await duckdbExecOnFileAsync(
    record.dbFile,
    `UPDATE fields SET name = '${sqlEscape(newName.trim())}' WHERE id = '${sqlEscape(fieldId)}'`,
  );
  if (!ok) return { error: "Failed to rename field", status: 500 as const };
  await regeneratePivotView(record.dbFile, objectName, record.object.id);
  await updateObjectYamlFields(objectName, record.dbFile, record.object.id);
  return { data: { ok: true }, status: 200 as const };
}

export async function deleteObjectField(objectName: string, fieldId: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const fieldExists = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  if ((fieldExists[0]?.cnt ?? 0) === 0) return { error: "Field not found", status: 404 as const };
  const ok1 = await duckdbExecOnFileAsync(record.dbFile, `DELETE FROM entry_fields WHERE field_id = '${sqlEscape(fieldId)}'`);
  const ok2 = await duckdbExecOnFileAsync(record.dbFile, `DELETE FROM fields WHERE id = '${sqlEscape(fieldId)}'`);
  if (!ok1 || !ok2) return { error: "Failed to delete field", status: 500 as const };
  await regeneratePivotView(record.dbFile, objectName, record.object.id);
  await updateObjectYamlFields(objectName, record.dbFile, record.object.id);
  return { data: { ok: true }, status: 200 as const };
}

export async function renameObjectEnumValue(objectName: string, fieldId: string, oldValue: string, newValue: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  if (!oldValue || !newValue) return { error: "oldValue and newValue are required", status: 400 as const };
  if (oldValue.trim() === newValue.trim()) return { data: { ok: true, changed: 0 }, status: 200 as const };
  const fields = await duckdbQueryOnFileAsync<{ enum_values: string | null }>(
    record.dbFile,
    `SELECT enum_values FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  if (fields.length === 0) return { error: "Field not found", status: 404 as const };
  let enumValues: string[];
  try {
    enumValues = fields[0].enum_values ? JSON.parse(fields[0].enum_values) : [];
  } catch {
    return { error: "Invalid enum_values in field", status: 500 as const };
  }
  const index = enumValues.indexOf(oldValue.trim());
  if (index === -1) return { error: `Enum value '${oldValue}' not found`, status: 404 as const };
  if (enumValues.includes(newValue.trim())) return { error: `Enum value '${newValue}' already exists`, status: 409 as const };
  enumValues[index] = newValue.trim();
  await duckdbExecOnFileAsync(
    record.dbFile,
    `UPDATE fields SET enum_values = '${sqlEscape(JSON.stringify(enumValues))}' WHERE id = '${sqlEscape(fieldId)}'`,
  );
  const updated = await duckdbExecOnFileAsync(
    record.dbFile,
    `UPDATE entry_fields SET value = '${sqlEscape(newValue.trim())}' WHERE field_id = '${sqlEscape(fieldId)}' AND value = '${sqlEscape(oldValue.trim())}'`,
  );
  return { data: { ok: true, updated }, status: 200 as const };
}

export async function getObjectEntryOptions(objectName: string, query: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const fields = await duckdbQueryOnFileAsync<FieldRow>(
    record.dbFile,
    `SELECT * FROM fields WHERE object_id = '${sqlEscape(record.object.id)}' ORDER BY sort_order`,
  );
  const displayFieldName = resolveDisplayFieldName(record.object, fields);
  const displayFieldId = fields.find((field) => field.name === displayFieldName)?.id;
  const escapedQuery = sqlEscape(query.trim().toLowerCase());
  const searchWhereSql = query.trim()
    ? `
        AND (
          LOWER(e.id) LIKE '%${escapedQuery}%'
          OR EXISTS (
            SELECT 1
            FROM entry_fields search_ef
            WHERE search_ef.entry_id = e.id
              AND search_ef.value IS NOT NULL
              AND LOWER(search_ef.value) LIKE '%${escapedQuery}%'
          )
        )
      `
    : "";
  const rows = await duckdbQueryOnFileAsync<{ entry_id: string; label: string | null }>(
    record.dbFile,
    `SELECT
      e.id as entry_id,
      display_ef.value as label
     FROM entries e
     LEFT JOIN entry_fields display_ef
       ON display_ef.entry_id = e.id
      ${displayFieldId ? `AND display_ef.field_id = '${sqlEscape(displayFieldId)}'` : "AND 1 = 0"}
     WHERE e.object_id = '${sqlEscape(record.object.id)}'
     ${searchWhereSql}
     ORDER BY COALESCE(display_ef.value, e.id) ASC
     LIMIT 200`,
  );
  return {
    data: {
      options: rows.map((row) => ({ id: row.entry_id, label: row.label || row.entry_id })),
      displayField: displayFieldName,
    },
    status: 200 as const,
  };
}

export async function createObjectEntry(objectName: string, fieldsInput?: Record<string, string>) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const idRows = await duckdbQueryOnFileAsync<{ id: string }>(record.dbFile, "SELECT uuid()::VARCHAR as id");
  const entryId = idRows[0]?.id;
  if (!entryId) return { error: "Failed to generate UUID", status: 500 as const };
  const now = new Date().toISOString();
  const ok = await duckdbExecOnFileAsync(
    record.dbFile,
    `INSERT INTO entries (id, object_id, created_at, updated_at) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(record.object.id)}', '${now}', '${now}')`,
  );
  if (!ok) return { error: "Failed to create entry", status: 500 as const };
  if (fieldsInput && typeof fieldsInput === "object") {
    const dbFields = await duckdbQueryOnFileAsync<{ id: string; name: string }>(
      record.dbFile,
      `SELECT id, name FROM fields WHERE object_id = '${sqlEscape(record.object.id)}'`,
    );
    const fieldMap = new Map(dbFields.map((field) => [field.name, field.id]));
    for (const [fieldName, value] of Object.entries(fieldsInput)) {
      const fieldId = fieldMap.get(fieldName);
      if (!fieldId || value == null) continue;
      await duckdbExecOnFileAsync(
        record.dbFile,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(fieldId)}', '${sqlEscape(String(value))}')`,
      );
    }
  }
  return { data: { entryId, ok: true }, status: 201 as const };
}

export function getObjectsControlApiContext() {
  return {
    workspace: getActiveWorkspaceName(),
  };
}

type StatusRow = {
  id: string;
  name: string;
  color?: string;
  sort_order?: number;
  is_default?: boolean;
};

type EavRow = {
  entry_id: string;
  created_at: string;
  updated_at: string;
  field_name: string;
  value: string | null;
};

type EntryDocResolution = {
  absolute: string;
  source: "documents" | "legacy" | "generated";
  title: string;
  workspaceRelative: string;
};

type ReverseRelationLink = {
  displayField: string;
  fieldName: string;
  links: Array<{ id: string; label: string }>;
  sourceObjectId: string;
  sourceObjectName: string;
};

function parseRelationValue(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(String).filter(Boolean);
      }
    } catch {}
  }
  return [trimmed];
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeSqlName(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

function decodeFilters(encoded: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSimpleOrderByClause(sortParam: string | null): string | null {
  if (!sortParam) return null;
  try {
    const parsed = JSON.parse(sortParam) as Array<{ field?: unknown; direction?: unknown }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const clauses = parsed
      .filter((rule): rule is { field: string; direction?: string } => typeof rule?.field === "string" && rule.field.length > 0)
      .map((rule) => `${safeSqlName(rule.field)} ${rule.direction === "desc" ? "DESC" : "ASC"}`);
    return clauses.length > 0 ? clauses.join(", ") : null;
  } catch {
    return null;
  }
}

function buildSimpleWhereClause(
  filtersParam: string | null,
  searchParam: string | null,
  fields: FieldRow[],
): string {
  const conditions: string[] = [];
  if (searchParam?.trim()) {
    const search = sqlEscape(searchParam.toLowerCase());
    const textFields = fields.filter((field) => ["email", "richtext", "text", "url"].includes(field.type));
    if (textFields.length > 0) {
      conditions.push(`(${textFields.map((field) => `LOWER(CAST(${safeSqlName(field.name)} AS VARCHAR)) LIKE '%${search}%'`).join(" OR ")})`);
    }
  }
  const decodedFilters = filtersParam ? decodeFilters(filtersParam) : null;
  if (decodedFilters && Array.isArray(decodedFilters.rules)) {
    for (const rule of decodedFilters.rules as Array<Record<string, unknown>>) {
      if (typeof rule?.field !== "string" || typeof rule?.operator !== "string") continue;
      const field = fields.find((item) => item.name === rule.field);
      if (!field) continue;
      const value = rule.value;
      const column = safeSqlName(rule.field);
      if ((rule.operator === "equals" || rule.operator === "is") && typeof value === "string") {
        conditions.push(`${column} = '${sqlEscape(value)}'`);
      } else if ((rule.operator === "contains") && typeof value === "string") {
        conditions.push(`LOWER(CAST(${column} AS VARCHAR)) LIKE '%${sqlEscape(value.toLowerCase())}%'`);
      } else if (rule.operator === "is_empty") {
        conditions.push(`(${column} IS NULL OR CAST(${column} AS VARCHAR) = '')`);
      } else if (rule.operator === "is_not_empty") {
        conditions.push(`(${column} IS NOT NULL AND CAST(${column} AS VARCHAR) != '')`);
      }
    }
  }
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

async function getObjectFields(dbFile: string, objectId: string) {
  return duckdbQueryOnFileAsync<FieldRow>(
    dbFile,
    `SELECT * FROM fields WHERE object_id = '${sqlEscape(objectId)}' ORDER BY sort_order`,
  );
}

async function resolveRelationLabels(
  dbFile: string,
  fields: FieldRow[],
  entries: Record<string, unknown>[],
) {
  const labels: Record<string, Record<string, string>> = {};
  const relatedObjectNames: Record<string, string> = {};

  for (const relationField of fields.filter((field) => field.type === "relation" && field.related_object_id)) {
    const relatedObjects = await duckdbQueryOnFileAsync<ObjectRow>(
      dbFile,
      `SELECT * FROM objects WHERE id = '${sqlEscape(relationField.related_object_id!)}' LIMIT 1`,
    );
    if (relatedObjects.length === 0) continue;
    const relatedObject = relatedObjects[0];
    relatedObjectNames[relationField.name] = relatedObject.name;
    const relatedFields = await getObjectFields(dbFile, relatedObject.id);
    const displayField = resolveDisplayFieldName(relatedObject, relatedFields);

    const ids = new Set<string>();
    for (const entry of entries) {
      const rawValue = entry[relationField.name];
      const asString = typeof rawValue === "string"
        ? rawValue
        : rawValue == null
          ? ""
          : JSON.stringify(rawValue);
      for (const id of parseRelationValue(asString)) {
        ids.add(id);
      }
    }

    if (ids.size === 0) {
      labels[relationField.name] = {};
      continue;
    }

    const idList = [...ids].map((id) => `'${sqlEscape(id)}'`).join(",");
    const rows = await duckdbQueryOnFileAsync<{ entry_id: string; value: string }>(
      dbFile,
      `SELECT e.id as entry_id, ef.value
       FROM entries e
       JOIN entry_fields ef ON ef.entry_id = e.id
       JOIN fields f ON f.id = ef.field_id
       WHERE e.id IN (${idList})
         AND f.object_id = '${sqlEscape(relatedObject.id)}'
         AND f.name = '${sqlEscape(displayField)}'`,
    );
    const labelMap: Record<string, string> = {};
    for (const row of rows) {
      labelMap[row.entry_id] = row.value || row.entry_id;
    }
    for (const id of ids) {
      if (!labelMap[id]) {
        labelMap[id] = id;
      }
    }
    labels[relationField.name] = labelMap;
  }

  return { labels, relatedObjectNames };
}

async function findReverseRelationsForEntry(objectId: string, entryId: string): Promise<ReverseRelationLink[]> {
  const result: ReverseRelationLink[] = [];
  for (const dbFile of discoverDuckDBPaths()) {
    const reverseFields = await duckdbQueryOnFileAsync<{
      id: string;
      name: string;
      object_id: string;
      source_object_name: string;
    }>(
      dbFile,
      `SELECT f.id, f.name, f.object_id, o.name as source_object_name
       FROM fields f
       JOIN objects o ON o.id = f.object_id
       WHERE f.type = 'relation'
         AND f.related_object_id = '${sqlEscape(objectId)}'`,
    );

    for (const reverseField of reverseFields) {
      const referenceRows = await duckdbQueryOnFileAsync<{ source_entry_id: string; target_value: string }>(
        dbFile,
        `SELECT ef.entry_id as source_entry_id, ef.value as target_value
         FROM entry_fields ef
         WHERE ef.field_id = '${sqlEscape(reverseField.id)}'
           AND ef.value IS NOT NULL
           AND ef.value != ''`,
      );
      const sourceEntryIds = referenceRows
        .filter((row) => parseRelationValue(row.target_value).includes(entryId))
        .map((row) => row.source_entry_id);
      if (sourceEntryIds.length === 0) continue;

      const sourceObjects = await duckdbQueryOnFileAsync<ObjectRow>(
        dbFile,
        `SELECT * FROM objects WHERE id = '${sqlEscape(reverseField.object_id)}' LIMIT 1`,
      );
      if (sourceObjects.length === 0) continue;
      const sourceFields = await getObjectFields(dbFile, reverseField.object_id);
      const displayField = resolveDisplayFieldName(sourceObjects[0], sourceFields);
      const idList = sourceEntryIds.map((id) => `'${sqlEscape(id)}'`).join(",");
      const displayRows = await duckdbQueryOnFileAsync<{ entry_id: string; value: string }>(
        dbFile,
        `SELECT ef.entry_id, ef.value
         FROM entry_fields ef
         JOIN fields f ON f.id = ef.field_id
         WHERE ef.entry_id IN (${idList})
           AND f.name = '${sqlEscape(displayField)}'
           AND f.object_id = '${sqlEscape(reverseField.object_id)}'`,
      );
      const displayMap: Record<string, string> = {};
      for (const row of displayRows) {
        displayMap[row.entry_id] = row.value || row.entry_id;
      }
      result.push({
        displayField,
        fieldName: reverseField.name,
        links: sourceEntryIds.map((id) => ({ id, label: displayMap[id] || id })),
        sourceObjectId: reverseField.object_id,
        sourceObjectName: reverseField.source_object_name,
      });
    }
  }
  return result;
}

function pivotEavRows(rows: EavRow[]): Record<string, unknown>[] {
  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    let entry = grouped.get(row.entry_id);
    if (!entry) {
      entry = {
        created_at: row.created_at,
        entry_id: row.entry_id,
        updated_at: row.updated_at,
      };
      grouped.set(row.entry_id, entry);
    }
    entry[row.field_name] = row.value;
  }
  return [...grouped.values()];
}

export async function getObjectDetail(objectName: string, urlString: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(objectName)) {
    return { error: "Invalid object name", status: 400 as const };
  }

  const record = await findObjectRecord(objectName);
  if (!record) {
    return { error: `Object '${objectName}' not found`, status: 404 as const };
  }

  await duckdbExecOnFileAsync(record.dbFile, "ALTER TABLE objects ADD COLUMN IF NOT EXISTS display_field VARCHAR");
  let fields = await getObjectFields(record.dbFile, record.object.id);
  if (fields.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    fields = await getObjectFields(record.dbFile, record.object.id);
  }
  const statuses = await duckdbQueryOnFileAsync<StatusRow>(
    record.dbFile,
    `SELECT * FROM statuses WHERE object_id = '${sqlEscape(record.object.id)}' ORDER BY sort_order`,
  );

  const url = new URL(urlString);
  const whereClause = buildSimpleWhereClause(
    url.searchParams.get("filters"),
    url.searchParams.get("search"),
    fields,
  );
  const orderByClause = buildSimpleOrderByClause(url.searchParams.get("sort")) ?? "created_at DESC, entry_id DESC";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const pageSize = Math.min(5000, Math.max(1, Number(url.searchParams.get("pageSize") || "100")));
  const offset = (page - 1) * pageSize;

  let entries: Record<string, unknown>[] = [];
  let totalCount = 0;

  try {
    const countRows = await duckdbQueryOnFileAsync<{ cnt: number }>(
      record.dbFile,
      `SELECT COUNT(*) as cnt FROM v_${objectName}${whereClause}`,
    );
    totalCount = countRows[0]?.cnt ?? 0;
    entries = await duckdbQueryOnFileAsync<Record<string, unknown>>(
      record.dbFile,
      `SELECT * FROM v_${objectName}${whereClause} ORDER BY ${orderByClause} LIMIT ${pageSize} OFFSET ${offset}`,
    );
  } catch {
    const rawRows = await duckdbQueryOnFileAsync<EavRow>(
      record.dbFile,
      `SELECT e.id as entry_id, e.created_at, e.updated_at, f.name as field_name, ef.value
       FROM entries e
       JOIN entry_fields ef ON ef.entry_id = e.id
       JOIN fields f ON f.id = ef.field_id
       WHERE e.object_id = '${sqlEscape(record.object.id)}'
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 5000`,
    );
    entries = pivotEavRows(rawRows);
    totalCount = entries.length;
  }

  const parsedFields = fields.map((field) => ({
    ...field,
    enum_colors: field.enum_values ? tryParseJson((field as FieldRow & { enum_colors?: string }).enum_values) : undefined,
    enum_values: field.enum_values ? tryParseJson(field.enum_values) : undefined,
  }));
  const { labels: relationLabels, relatedObjectNames } = await resolveRelationLabels(record.dbFile, fields, entries);
  const reverseRelations: ReverseRelationLink[] = [];
  const views = await getObjectViews(objectName);

  return {
    data: {
      activeView: views.activeView,
      effectiveDisplayField: resolveDisplayFieldName(record.object, fields),
      entries,
      fields: parsedFields.map((field) => ({
        ...field,
        related_object_name: field.type === "relation" ? relatedObjectNames[field.name] : undefined,
      })),
      object: record.object,
      page,
      pageSize,
      relationLabels,
      reverseRelations,
      savedViews: views.views,
      statuses,
      totalCount,
      viewSettings: views.viewSettings,
    },
    status: 200 as const,
  };
}

export async function getObjectEntryDetail(objectName: string, entryId: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  if (!entryId || entryId.length > 64) return { error: "Invalid entry ID", status: 400 as const };

  const fields = await getObjectFields(record.dbFile, record.object.id);
  const rows = await duckdbQueryOnFileAsync<EavRow>(
    record.dbFile,
    `SELECT e.id as entry_id, e.created_at, e.updated_at, f.name as field_name, ef.value
     FROM entries e
     JOIN entry_fields ef ON ef.entry_id = e.id
     JOIN fields f ON f.id = ef.field_id
     WHERE e.id = '${sqlEscape(entryId)}'
       AND e.object_id = '${sqlEscape(record.object.id)}'`,
  );
  const exists = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM entries WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  if ((exists[0]?.cnt ?? 0) === 0) return { error: "Entry not found", status: 404 as const };

  const entry = pivotEavRows(rows)[0] ?? { entry_id: entryId };
  const { labels: relationLabels, relatedObjectNames } = await resolveRelationLabels(record.dbFile, fields, [entry]);
  const reverseRelations = await findReverseRelationsForEntry(record.object.id, entryId);

  return {
    data: {
      effectiveDisplayField: resolveDisplayFieldName(record.object, fields),
      entry,
      fields: fields.map((field) => ({
        ...field,
        enum_colors: (field as FieldRow & { enum_colors?: string }).enum_values ? tryParseJson((field as FieldRow & { enum_colors?: string }).enum_values) : undefined,
        enum_values: field.enum_values ? tryParseJson(field.enum_values) : undefined,
        related_object_name: field.type === "relation" ? relatedObjectNames[field.name] : undefined,
      })),
      object: record.object,
      relationLabels,
      reverseRelations,
    },
    status: 200 as const,
  };
}

export async function updateObjectEntry(
  objectName: string,
  entryId: string,
  fieldUpdates: Record<string, unknown>,
) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const exists = await duckdbQueryOnFileAsync<{ cnt: number }>(
    record.dbFile,
    `SELECT COUNT(*) as cnt FROM entries WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  if ((exists[0]?.cnt ?? 0) === 0) return { error: "Entry not found", status: 404 as const };

  const dbFields = await duckdbQueryOnFileAsync<{ id: string; name: string }>(
    record.dbFile,
    `SELECT id, name FROM fields WHERE object_id = '${sqlEscape(record.object.id)}'`,
  );
  const fieldMap = new Map(dbFields.map((field) => [field.name, field.id]));
  let updatedCount = 0;
  for (const [fieldName, value] of Object.entries(fieldUpdates)) {
    const fieldId = fieldMap.get(fieldName);
    if (!fieldId) continue;
    const hasRow = await duckdbQueryOnFileAsync<{ cnt: number }>(
      record.dbFile,
      `SELECT COUNT(*) as cnt FROM entry_fields WHERE entry_id = '${sqlEscape(entryId)}' AND field_id = '${sqlEscape(fieldId)}'`,
    );
    const escapedValue = value == null ? "NULL" : `'${sqlEscape(String(value))}'`;
    if ((hasRow[0]?.cnt ?? 0) > 0) {
      await duckdbExecOnFileAsync(
        record.dbFile,
        `UPDATE entry_fields SET value = ${escapedValue} WHERE entry_id = '${sqlEscape(entryId)}' AND field_id = '${sqlEscape(fieldId)}'`,
      );
    } else {
      await duckdbExecOnFileAsync(
        record.dbFile,
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(fieldId)}', ${escapedValue})`,
      );
    }
    updatedCount += 1;
  }
  await duckdbExecOnFileAsync(
    record.dbFile,
    `UPDATE entries SET updated_at = '${new Date().toISOString()}' WHERE id = '${sqlEscape(entryId)}'`,
  );
  return { data: { ok: true, updatedCount }, status: 200 as const };
}

export async function deleteObjectEntry(objectName: string, entryId: string) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  await duckdbExecOnFileAsync(record.dbFile, `DELETE FROM entry_fields WHERE entry_id = '${sqlEscape(entryId)}'`);
  await duckdbExecOnFileAsync(
    record.dbFile,
    `DELETE FROM entries WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  return { data: { ok: true }, status: 200 as const };
}

export async function bulkDeleteObjectEntries(objectName: string, entryIds: string[]) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return { error: "entryIds must be a non-empty array", status: 400 as const };
  }
  const idList = entryIds.map((entryId) => `'${sqlEscape(entryId)}'`).join(",");
  await duckdbExecOnFileAsync(record.dbFile, `DELETE FROM entry_fields WHERE entry_id IN (${idList})`);
  await duckdbExecOnFileAsync(
    record.dbFile,
    `DELETE FROM entries WHERE id IN (${idList}) AND object_id = '${sqlEscape(record.object.id)}'`,
  );
  return { data: { deletedCount: entryIds.length, ok: true }, status: 200 as const };
}

function resolveObjectContext(objectName: string) {
  const objectDir = findObjectDir(objectName);
  const workspaceRoot = resolveWorkspaceRoot();
  return findObjectRecord(objectName).then((record) => {
    if (!record || !objectDir) return null;
    return {
      dbFile: record.dbFile,
      objectDir,
      objectId: record.object.id,
      objectName,
      workspaceRoot,
    };
  });
}

function toResolution(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  absolute: string,
  title: string,
  source: EntryDocResolution["source"],
): EntryDocResolution {
  return {
    absolute,
    source,
    title,
    workspaceRelative: context.workspaceRoot
      ? relative(context.workspaceRoot, absolute)
      : `${context.objectName}/${absolute.split("/").pop() ?? ""}`,
  };
}

async function hasDocumentsEntryIdColumn(dbFile: string) {
  const rows = await duckdbQueryOnFileAsync<{ cnt: number }>(
    dbFile,
    `SELECT COUNT(*) as cnt
     FROM information_schema.columns
     WHERE table_name = 'documents' AND column_name = 'entry_id'`,
  );
  return (rows[0]?.cnt ?? 0) > 0;
}

async function ensureDocumentsEntryIdColumn(dbFile: string) {
  await duckdbExecOnFileAsync(
    dbFile,
    `CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
      title VARCHAR DEFAULT 'Untitled',
      icon VARCHAR,
      cover_image VARCHAR,
      file_path VARCHAR NOT NULL UNIQUE,
      parent_id VARCHAR REFERENCES documents(id),
      parent_object_id VARCHAR REFERENCES objects(id),
      entry_id VARCHAR REFERENCES entries(id),
      sort_order INTEGER DEFAULT 0,
      is_published BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
  );
  await duckdbExecOnFileAsync(dbFile, "ALTER TABLE documents ADD COLUMN IF NOT EXISTS entry_id VARCHAR");
}

async function readEntryFieldMap(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
) {
  const rows = await duckdbQueryOnFileAsync<{ field_name: string; value: string | null }>(
    context.dbFile,
    `SELECT f.name as field_name, ef.value
     FROM entry_fields ef
     JOIN fields f ON f.id = ef.field_id
     WHERE ef.entry_id = '${sqlEscape(entryId)}'`,
  );
  const fieldMap: Record<string, string> = {};
  for (const row of rows) {
    if (row.field_name && row.value) {
      fieldMap[row.field_name] = row.value;
    }
  }
  return fieldMap;
}

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function extractYouTubeHandle(urlValue: string | undefined) {
  const value = urlValue?.trim();
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) return parts[0].slice(1);
    if ((parts[0] === "c" || parts[0] === "channel" || parts[0] === "user") && parts[1]) return parts[1];
  } catch {}
  const match = value.match(/@([A-Za-z0-9._-]+)/);
  return match?.[1] ?? null;
}

function pickDocumentTitle(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
  fields: Record<string, string>,
) {
  return firstNonEmpty(
    fields["Document Title"],
    fields["Title"],
    fields["Channel Name"],
    fields["Creator Name"],
    fields["Full Name"],
    fields["Name"],
    fields["Company Name"],
    fields["Deal Name"],
    fields["Case Number"],
    fields["Invoice Number"],
    fields["Address"],
    fields["Email"],
  ) ?? `${context.objectName} ${entryId}`;
}

function buildReadableStem(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  fields: Record<string, string>,
  title: string,
) {
  const explicitSlug = firstNonEmpty(fields["Document Slug"], fields["Slug"], fields["File Slug"]);
  if (explicitSlug) return slugify(explicitSlug) || "entry";
  const youtubeHandle = extractYouTubeHandle(fields["YouTube URL"]);
  if (youtubeHandle) return `yt-${slugify(youtubeHandle)}`;
  return slugify(title) || slugify(context.objectName) || "entry";
}

async function lookupRegisteredDocument(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
) {
  if (!(await hasDocumentsEntryIdColumn(context.dbFile))) return null;
  const rows = await duckdbQueryOnFileAsync<{ file_path: string; title: string | null }>(
    context.dbFile,
    `SELECT file_path, title
     FROM documents
     WHERE entry_id = '${sqlEscape(entryId)}'
       AND parent_object_id = '${sqlEscape(context.objectId)}'
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function lookupRegisteredEntryIdByPath(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  workspaceRelativePath: string,
) {
  if (!(await hasDocumentsEntryIdColumn(context.dbFile))) return null;
  const rows = await duckdbQueryOnFileAsync<{ entry_id: string | null }>(
    context.dbFile,
    `SELECT entry_id FROM documents WHERE file_path = '${sqlEscape(workspaceRelativePath)}' LIMIT 1`,
  );
  return rows[0]?.entry_id ?? null;
}

async function buildGeneratedResolution(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
) {
  const fields = await readEntryFieldMap(context, entryId);
  const title = pickDocumentTitle(context, entryId, fields);
  const stem = buildReadableStem(context, fields, title);
  for (let index = 1; index <= 999; index += 1) {
    const absolute = join(context.objectDir, `${stem}-${String(index).padStart(3, "0")}.md`);
    const resolution = toResolution(context, absolute, title, "generated");
    const ownerEntryId = await lookupRegisteredEntryIdByPath(context, resolution.workspaceRelative);
    if (ownerEntryId === entryId) return resolution;
    if (ownerEntryId) continue;
    if (!existsSync(absolute)) return resolution;
  }
  return toResolution(context, join(context.objectDir, `${stem}-999.md`), title, "generated");
}

async function resolveEntryMdPath(objectName: string, entryId: string) {
  const context = await resolveObjectContext(objectName);
  if (!context) return null;
  const registered = await lookupRegisteredDocument(context, entryId);
  if (registered) {
    const absolute = context.workspaceRoot && !registered.file_path.startsWith("/")
      ? join(context.workspaceRoot, registered.file_path)
      : registered.file_path.startsWith("/")
        ? registered.file_path
        : join(context.objectDir, registered.file_path.split("/").pop() ?? registered.file_path);
    return {
      context,
      resolution: toResolution(
        context,
        absolute,
        registered.title?.trim() || registered.file_path.split("/").pop()?.replace(/\.mdx?$/, "") || entryId,
        "documents",
      ),
    };
  }
  const legacyAbsolute = join(context.objectDir, `${entryId}.md`);
  if (existsSync(legacyAbsolute)) {
    return {
      context,
      resolution: toResolution(context, legacyAbsolute, pickDocumentTitle(context, entryId, await readEntryFieldMap(context, entryId)), "legacy"),
    };
  }
  return { context, resolution: await buildGeneratedResolution(context, entryId) };
}

async function verifyEntryExists(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
) {
  const rows = await duckdbQueryOnFileAsync<{ cnt: number }>(
    context.dbFile,
    `SELECT COUNT(*) as cnt FROM entries WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(context.objectId)}'`,
  );
  return (rows[0]?.cnt ?? 0) > 0;
}

async function registerEntryDocument(
  context: NonNullable<Awaited<ReturnType<typeof resolveObjectContext>>>,
  entryId: string,
  resolution: EntryDocResolution,
) {
  await ensureDocumentsEntryIdColumn(context.dbFile);
  const title = sqlEscape(resolution.title);
  const filePath = sqlEscape(resolution.workspaceRelative);
  const objectId = sqlEscape(context.objectId);
  const safeEntryId = sqlEscape(entryId);
  await duckdbExecOnFileAsync(
    context.dbFile,
    `UPDATE documents
     SET title = '${title}', file_path = '${filePath}', parent_object_id = '${objectId}', entry_id = '${safeEntryId}', updated_at = now()
     WHERE entry_id = '${safeEntryId}' AND parent_object_id = '${objectId}'`,
  );
  await duckdbExecOnFileAsync(
    context.dbFile,
    `UPDATE documents
     SET title = '${title}', parent_object_id = '${objectId}', entry_id = '${safeEntryId}', updated_at = now()
     WHERE file_path = '${filePath}' AND (entry_id IS NULL OR entry_id = '${safeEntryId}')`,
  );
  await duckdbExecOnFileAsync(
    context.dbFile,
    `INSERT INTO documents (title, file_path, parent_object_id, entry_id)
     SELECT '${title}', '${filePath}', '${objectId}', '${safeEntryId}'
     WHERE NOT EXISTS (
       SELECT 1 FROM documents
       WHERE (entry_id = '${safeEntryId}' AND parent_object_id = '${objectId}')
         OR file_path = '${filePath}'
     )`,
  );
}

export async function getObjectEntryContent(objectName: string, entryId: string) {
  const resolved = await resolveEntryMdPath(objectName, entryId);
  if (!resolved) {
    return { data: { content: "", exists: false, path: `${objectName}/${entryId}.md` }, status: 200 as const };
  }
  if (existsSync(resolved.resolution.absolute)) {
    return {
      data: {
        content: readFileSync(resolved.resolution.absolute, "utf-8"),
        exists: true,
        path: resolved.resolution.workspaceRelative,
      },
      status: 200 as const,
    };
  }
  return {
    data: {
      content: "",
      exists: false,
      path: resolved.resolution.workspaceRelative,
    },
    status: 200 as const,
  };
}

export async function writeObjectEntryContent(objectName: string, entryId: string, content: string) {
  const resolved = await resolveEntryMdPath(objectName, entryId);
  if (!resolved) return { error: "Object directory not found", status: 404 as const };
  if (!(await verifyEntryExists(resolved.context, entryId))) {
    return { error: "Entry not found", status: 404 as const };
  }
  if (!content.trim() && !existsSync(resolved.resolution.absolute)) {
    return { data: { ok: true, created: false, path: resolved.resolution.workspaceRelative }, status: 200 as const };
  }
  const alreadyExists = existsSync(resolved.resolution.absolute);
  mkdirSync(dirname(resolved.resolution.absolute), { recursive: true });
  writeFileSync(resolved.resolution.absolute, content, "utf-8");
  await registerEntryDocument(resolved.context, entryId, resolved.resolution);
  return {
    data: { ok: true, created: !alreadyExists, path: resolved.resolution.workspaceRelative },
    status: 200 as const,
  };
}

function parseActionConfig(defaultValue: string | null): ActionConfig[] {
  if (!defaultValue) return [];
  try {
    const parsed = JSON.parse(defaultValue) as { actions?: ActionConfig[] };
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
  }
}

async function ensureActionRunsTable(dbFile: string) {
  const rows = await duckdbQueryOnFileAsync<{ cnt: number }>(
    dbFile,
    "SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = 'action_runs'",
  );
  if (rows[0]?.cnt) return;
  await duckdbExecOnFileAsync(
    dbFile,
    `CREATE TABLE IF NOT EXISTS action_runs (
      id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
      action_id VARCHAR NOT NULL,
      field_id VARCHAR NOT NULL,
      entry_id VARCHAR NOT NULL,
      object_id VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending',
      started_at TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ,
      result VARCHAR,
      error VARCHAR,
      stdout VARCHAR,
      exit_code INTEGER
    )`,
  );
}

async function persistActionRun(
  dbFile: string,
  run: {
    actionId: string;
    entryId: string;
    error: string | null;
    exitCode: number | null;
    fieldId: string;
    objectId: string;
    result: string | null;
    status: string;
  },
) {
  await ensureActionRunsTable(dbFile);
  await duckdbExecOnFileAsync(
    dbFile,
    `INSERT INTO action_runs (action_id, field_id, entry_id, object_id, status, completed_at, result, error, exit_code)
     VALUES (
       '${sqlEscape(run.actionId)}',
       '${sqlEscape(run.fieldId)}',
       '${sqlEscape(run.entryId)}',
       '${sqlEscape(run.objectId)}',
       '${sqlEscape(run.status)}',
       now(),
       ${run.result ? `'${sqlEscape(run.result)}'` : "NULL"},
       ${run.error ? `'${sqlEscape(run.error)}'` : "NULL"},
       ${run.exitCode !== null ? run.exitCode : "NULL"}
     )`,
  );
}

export async function getObjectActionRuns(
  objectName: string,
  filters: { actionId?: string | null; entryId?: string | null; fieldId?: string | null; limit?: number | null },
) {
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  try {
    await ensureActionRunsTable(record.dbFile);
  } catch {
    return { data: { runs: [] }, status: 200 as const };
  }
  const conditions: string[] = [];
  if (filters.actionId) conditions.push(`action_id = '${sqlEscape(filters.actionId)}'`);
  if (filters.entryId) conditions.push(`entry_id = '${sqlEscape(filters.entryId)}'`);
  if (filters.fieldId) conditions.push(`field_id = '${sqlEscape(filters.fieldId)}'`);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 20, 100);
  const runs = await duckdbQueryOnFileAsync(
    record.dbFile,
    `SELECT id, action_id, field_id, entry_id, status, started_at, completed_at, result, error, exit_code
     FROM action_runs ${whereClause}
     ORDER BY started_at DESC
     LIMIT ${limit}`,
  );
  return { data: { runs }, status: 200 as const };
}

export async function executeObjectAction(
  objectName: string,
  body: { actionId?: unknown; entryIds?: unknown; fieldId?: unknown },
) {
  const actionId = typeof body.actionId === "string" ? body.actionId : "";
  const fieldId = typeof body.fieldId === "string" ? body.fieldId : "";
  const entryIds = Array.isArray(body.entryIds) ? body.entryIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  if (!actionId || !fieldId || entryIds.length === 0) {
    return { error: "actionId, fieldId, and entryIds[] required", status: 400 as const };
  }
  const record = await findObjectRecord(objectName);
  if (!record) return { error: "Object not found", status: 404 as const };
  const fields = await duckdbQueryOnFileAsync<{ default_value: string | null; id: string; name: string; type: string }>(
    record.dbFile,
    `SELECT id, name, type, default_value FROM fields WHERE id = '${sqlEscape(fieldId)}' AND type = 'action' LIMIT 1`,
  );
  if (fields.length === 0) return { error: "Action field not found", status: 404 as const };
  const action = parseActionConfig(fields[0].default_value).find((item) => item.id === actionId);
  if (!action) return { error: `Action '${actionId}' not found on field`, status: 404 as const };

  const workspacePath = resolveWorkspaceRoot() ?? "";
  const apiUrl = `http://127.0.0.1:${process.env.PORT || "4001"}/workspace`;
  const contexts: ActionContext[] = [];
  for (const entryId of entryIds) {
    const rows = await duckdbQueryOnFileAsync<Record<string, unknown>>(
      record.dbFile,
      `SELECT ef.value, f.name as field_name
       FROM entry_fields ef
       JOIN fields f ON f.id = ef.field_id
       WHERE ef.entry_id = '${sqlEscape(entryId)}'`,
    );
    const entryData: Record<string, unknown> = { entry_id: entryId };
    for (const row of rows) {
      if (typeof row.field_name === "string") {
        entryData[row.field_name] = row.value;
      }
    }
    contexts.push({
      actionId,
      apiUrl,
      dbPath: record.dbFile,
      entryData,
      entryId,
      fieldId,
      objectId: record.object.id,
      objectName,
      workspacePath,
    });
  }

  const runIdPrefix = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  const data = new ReadableStream({
    async start(controller) {
      function send(event: ActionEvent) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }

      try {
        const generator = contexts.length === 1
          ? runActionScript(action, contexts[0], `${runIdPrefix}_0`)
          : runBulkAction(action, contexts, runIdPrefix);
        for await (const event of generator) {
          send(event);
          if (event.type === "completed") {
            await persistActionRun(record.dbFile, {
              actionId,
              entryId: event.entryId,
              error: event.error ?? null,
              exitCode: event.exitCode ?? null,
              fieldId,
              objectId: record.object.id,
              result: event.result ? JSON.stringify(event.result) : null,
              status: event.status,
            });
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return {
    data,
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
    status: 200 as const,
  };
}
