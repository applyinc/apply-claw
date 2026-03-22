import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, relative } from "path";
import { findObjectDir, findDuckDBForObject, duckdbQueryOnFile, resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

function resolveEntryMdPath(objectName: string, entryId: string): { absolute: string; workspaceRelative: string } | null {
	const dir = findObjectDir(objectName);
	if (!dir) return null;
	const absolute = join(dir, `${entryId}.md`);
	const root = resolveWorkspaceRoot();
	const workspaceRelative = root ? relative(root, absolute) : `${objectName}/${entryId}.md`;
	return { absolute, workspaceRelative };
}

function verifyEntryExists(objectName: string, entryId: string): boolean {
	const dbFile = findDuckDBForObject(objectName);
	if (!dbFile) return false;

	const objects = duckdbQueryOnFile<{ id: string }>(
		dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(objectName)}' LIMIT 1`,
	);
	if (objects.length === 0) return false;

	const rows = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt FROM entries WHERE id = '${sqlEscape(entryId)}' AND object_id = '${sqlEscape(objects[0].id)}'`,
	);
	return (rows[0]?.cnt ?? 0) > 0;
}

/**
 * GET /api/workspace/objects/[name]/entries/[id]/content
 * Returns { content: string, exists: boolean } for the entry's .md file.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ name: string; id: string }> },
) {
	const { name, id } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}
	if (!id || id.length > 64) {
		return Response.json({ error: "Invalid entry ID" }, { status: 400 });
	}

	const resolved = resolveEntryMdPath(name, id);
	if (!resolved) {
		return Response.json({ content: "", exists: false, path: `${name}/${id}.md` });
	}

	if (existsSync(resolved.absolute)) {
		const content = readFileSync(resolved.absolute, "utf-8");
		return Response.json({ content, exists: true, path: resolved.workspaceRelative });
	}

	return Response.json({ content: "", exists: false, path: resolved.workspaceRelative });
}

/**
 * PUT /api/workspace/objects/[name]/entries/[id]/content
 * Write the entry's .md file. Creates the file on first write.
 * Body: { content: string }
 */
export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ name: string; id: string }> },
) {
	const { name, id } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}
	if (!id || id.length > 64) {
		return Response.json({ error: "Invalid entry ID" }, { status: 400 });
	}

	if (!verifyEntryExists(name, id)) {
		return Response.json({ error: "Entry not found" }, { status: 404 });
	}

	const resolved = resolveEntryMdPath(name, id);
	if (!resolved) {
		return Response.json({ error: "Object directory not found" }, { status: 404 });
	}

	const body = await req.json();
	const content = typeof body.content === "string" ? body.content : "";

	if (!content.trim() && !existsSync(resolved.absolute)) {
		return Response.json({ ok: true, created: false });
	}

	const alreadyExists = existsSync(resolved.absolute);
	mkdirSync(dirname(resolved.absolute), { recursive: true });
	writeFileSync(resolved.absolute, content, "utf-8");

	return Response.json({ ok: true, created: !alreadyExists });
}
