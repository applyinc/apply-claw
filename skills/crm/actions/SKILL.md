# Actions — Executable Buttons on CRM Objects

Actions are a field type (`type: "action"`) that renders clickable buttons on object entries. Each button executes a server-side script in **any language** — JavaScript, Python, bash, Ruby, Go, or any executable installed on the machine.

---

## Table of Contents

1. [Creating Action Fields](#creating-action-fields)
2. [Action Configuration](#action-configuration)
3. [Script Modes](#script-modes)
4. [Script Protocol](#script-protocol)
5. [Environment Variables](#environment-variables)
6. [Inline JS SDK](#inline-js-sdk)
7. [Action Runs](#action-runs)
8. [Bulk Execution](#bulk-execution)
9. [UI Rendering](#ui-rendering)
10. [Examples](#examples)

---

## Creating Action Fields

Create via SQL like any field, with `type = 'action'` and the action config in `default_value`:

```sql
INSERT INTO fields (id, object_id, name, type, default_value, sort_order)
VALUES (
  (SELECT uuid()::VARCHAR),
  '<object_id>',
  'Actions',
  'action',
  '{"actions":[{"id":"act_send_email","label":"Send Email","icon":"mail","variant":"primary","scriptPath":".actions/send-email.js","confirmMessage":"Send email to this contact?","loadingLabel":"Sending...","successLabel":"Sent!","autoResetMs":3000}]}',
  10
);
```

After creating the field:
1. **Regenerate the PIVOT view** — action fields are automatically excluded since they store no entry_fields values.
2. **Create the `.actions/` directory** under the object directory if using file-based scripts.
3. **Write the script file** at the referenced `scriptPath`.

You can also create action fields via the API:

```
POST /api/workspace/objects/{objectName}/fields
{
  "name": "Actions",
  "type": "action",
  "action_config": {
    "actions": [...]
  }
}
```

---

## Action Configuration

Each action field's `default_value` is a JSON object with an `actions` array:

```json
{
  "actions": [
    {
      "id": "act_unique_id",
      "label": "Button Label",
      "icon": "mail",
      "variant": "primary",
      "scriptPath": ".actions/my-script.js",
      "runtime": "auto",
      "confirmMessage": "Are you sure?",
      "loadingLabel": "Running...",
      "successLabel": "Done!",
      "errorLabel": "Failed",
      "autoResetMs": 3000,
      "timeout": 60000
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier for this action |
| `label` | string | yes | Button text displayed in idle state |
| `icon` | string | no | Icon name (decorative, not rendered from icon set yet) |
| `variant` | string | no | `"default"` \| `"primary"` \| `"destructive"` \| `"success"` \| `"warning"` |
| `scriptPath` | string | conditional | Path to script file relative to object directory |
| `script` | string | conditional | Inline JavaScript code (for simple actions) |
| `runtime` | string | no | `"auto"` \| `"inline"` \| `"node"` \| `"python"` \| `"bash"` \| `"ruby"` |
| `confirmMessage` | string | no | If set, shows confirmation dialog before running |
| `loadingLabel` | string | no | Text shown while script is running |
| `successLabel` | string | no | Text shown on success |
| `errorLabel` | string | no | Text shown on failure |
| `autoResetMs` | number | no | Milliseconds before button resets to idle (default: 3000) |
| `timeout` | number | no | Milliseconds before killing the script (default: 60000) |

Either `scriptPath` or `script` must be provided. If both are present, `scriptPath` takes precedence unless `runtime` is `"inline"`.

---

## Script Modes

### File-based scripts (`scriptPath`)

Scripts live as files in the workspace alongside the object:

```
workspace/
  leads/
    .object.yaml
    .actions/
      send-email.js
      generate-report.py
      deploy-webhook.sh
```

Runtime auto-detection by file extension:
- `.js`, `.mjs`, `.cjs` → `node`
- `.ts` → `npx tsx`
- `.py` → `python3`
- `.sh` → `bash`
- `.rb` → `ruby`
- No extension → direct execution (must be chmod +x)

### Inline scripts (`script`)

Short JavaScript snippets stored directly in the action config. Executed server-side via `node` with the Dench SDK pre-loaded:

```json
{
  "id": "act_mark_contacted",
  "label": "Mark Contacted",
  "variant": "success",
  "script": "await dench.objects.update(context.objectName, context.entryId, { Status: 'Contacted' });\nreturn { message: 'Updated' };",
  "runtime": "inline"
}
```

---

## Script Protocol

Scripts communicate results via **NDJSON on stdout**. Each line is a JSON object:

```jsonl
{"type":"progress","percent":50,"message":"Processing..."}
{"type":"log","level":"info","message":"Fetched 42 records"}
{"type":"result","status":"success","data":{"emailsSent":5}}
```

### Message types

| Type | Fields | Description |
|------|--------|-------------|
| `progress` | `percent`, `message?` | Updates progress bar in UI |
| `log` | `level`, `message` | Streamed to action output (`info`, `warn`, `error`) |
| `result` | `status`, `data?` | Final result. `status` is `"success"` or `"error"`. Terminates. |

Non-JSON stdout lines are treated as `log` messages with `level: "info"`.

Exit code: 0 = success, non-zero = error (standard Unix convention). If no `result` message is emitted, the exit code determines success/failure.

---

## Environment Variables

Every script receives these environment variables:

| Variable | Description |
|----------|-------------|
| `DENCH_ENTRY_ID` | The entry ID this action is running on |
| `DENCH_ENTRY_DATA` | Full entry data as JSON string |
| `DENCH_OBJECT_NAME` | Object name (e.g. `"leads"`) |
| `DENCH_OBJECT_ID` | Object ID |
| `DENCH_ACTION_ID` | Action ID from config |
| `DENCH_FIELD_ID` | Field ID the action belongs to |
| `DENCH_WORKSPACE_PATH` | Absolute path to workspace root |
| `DENCH_DB_PATH` | Absolute path to `workspace.duckdb` |
| `DENCH_API_URL` | Base URL for workspace REST APIs |

This means **any language** can participate — just read env vars and print JSON to stdout.

### Python example

```python
import os, json, requests

entry = json.loads(os.environ['DENCH_ENTRY_DATA'])
api = os.environ['DENCH_API_URL']
email = entry.get('Email Address', '')

print(json.dumps({"type": "progress", "percent": 50, "message": "Sending..."}))

requests.post(f"{api}/workspace/objects/people/entries/{os.environ['DENCH_ENTRY_ID']}", 
    json={"fields": {"Status": "Contacted"}},
    headers={"Content-Type": "application/json"})

print(json.dumps({"type": "result", "status": "success", "data": {"email": email}}))
```

### Bash example

```bash
#!/bin/bash
ENTRY=$(echo "$DENCH_ENTRY_DATA" | jq -r '.["Email Address"]')
echo "{\"type\":\"log\",\"level\":\"info\",\"message\":\"Processing $ENTRY\"}"
curl -s -X PATCH "$DENCH_API_URL/workspace/objects/$DENCH_OBJECT_NAME/entries/$DENCH_ENTRY_ID" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"Status":"Contacted"}}'
echo '{"type":"result","status":"success","data":{"sent":true}}'
```

---

## Inline JS SDK

For inline JS actions, the `dench` global provides:

| Method | Description |
|--------|-------------|
| `dench.objects.get(name, id)` | Get entry by object name and ID |
| `dench.objects.list(name)` | List entries for an object |
| `dench.objects.create(name, fields)` | Create a new entry |
| `dench.objects.update(name, id, fields)` | Update entry fields |
| `dench.objects.delete(name, id)` | Delete an entry |
| `dench.objects.bulkDelete(name, ids)` | Bulk delete entries |
| `dench.db.query(sql)` | Run read-only SQL on workspace DB |
| `dench.db.execute(sql)` | Execute SQL (write operations) |
| `dench.files.read(path)` | Read a workspace file |
| `dench.files.write(path, content)` | Write a workspace file |
| `dench.http.fetch(url, opts)` | Standard fetch (no proxy) |
| `dench.exec(cmd)` | Run a shell command synchronously |
| `dench.progress(percent, message)` | Report progress to UI |
| `dench.log(message, level)` | Log a message |
| `dench.complete(data)` | Signal successful completion |
| `dench.fail(message)` | Signal failure and exit |
| `dench.env.*` | Access all DENCH_* env vars as properties |

The `context` object is also available:
- `context.entryId`, `context.entryData`, `context.objectName`, `context.objectId`
- `context.actionId`, `context.fieldId`, `context.workspacePath`, `context.dbPath`, `context.apiUrl`

---

## Action Runs

Every execution is persisted in the `action_runs` table:

```sql
CREATE TABLE IF NOT EXISTS action_runs (
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
);
```

Query recent runs:
```
GET /api/workspace/objects/{name}/actions/runs?fieldId=...&entryId=...&limit=20
```

---

## Bulk Execution

When the user selects multiple rows in the table and clicks an action button in the bulk action bar:

1. The UI sends a single POST with all selected `entryIds`.
2. The server spawns up to 8 concurrent child processes (one per entry).
3. Each process gets its own `DENCH_ENTRY_ID` and `DENCH_ENTRY_DATA`.
4. Results stream back as SSE events per entry.
5. The UI updates each entry's button state independently.

---

## UI Rendering

Action buttons appear in:

1. **Table view**: As a column. Multiple actions show as compact buttons per row. Checkbox column (first, sticky) enables multi-row selection for bulk actions.
2. **Entry detail panel**: Full-width buttons in a dedicated "Actions" section below properties.
3. **Kanban cards**: Compact (icon-only) buttons at the bottom of each card.
4. **Bulk action bar**: Fixed bottom toolbar when rows are selected. Shows all available action buttons + a default "Delete" button.

Button states: idle → loading (with optional progress bar) → success/error → auto-reset to idle.

---

## Examples

### Simple status update (inline)

```json
{
  "id": "act_mark_done",
  "label": "Mark Done",
  "variant": "success",
  "script": "await dench.objects.update(context.objectName, context.entryId, { Status: 'Done' });\nreturn { message: 'Marked as done' };",
  "runtime": "inline",
  "successLabel": "Done!",
  "autoResetMs": 2000
}
```

### Send notification (Node.js file)

```javascript
// .actions/send-notification.js
const dench = require(process.env.DENCH_SDK_PATH || '../../node_modules/...')(process.env);
const entry = dench.env.entryData;

dench.progress(30, 'Preparing notification...');

const result = await fetch('https://hooks.slack.com/...', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: `New lead: ${entry['Full Name']}` }),
});

if (result.ok) {
  dench.complete({ notified: true });
} else {
  dench.fail('Slack notification failed');
}
```

### Data export (Python file)

```python
# .actions/export-csv.py
import os, json, csv, io

entry = json.loads(os.environ['DENCH_ENTRY_DATA'])
workspace = os.environ['DENCH_WORKSPACE_PATH']

print(json.dumps({"type": "progress", "percent": 50, "message": "Generating CSV..."}))

output_path = os.path.join(workspace, 'exports', f"{os.environ['DENCH_ENTRY_ID']}.csv")
os.makedirs(os.path.dirname(output_path), exist_ok=True)

with open(output_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(entry.keys())
    writer.writerow(entry.values())

print(json.dumps({"type": "result", "status": "success", "data": {"path": output_path}}))
```

### Destructive action with confirmation

```json
{
  "id": "act_archive",
  "label": "Archive",
  "variant": "destructive",
  "confirmMessage": "This will move the entry to the archive. Continue?",
  "scriptPath": ".actions/archive.sh",
  "loadingLabel": "Archiving...",
  "successLabel": "Archived",
  "errorLabel": "Archive failed"
}
```
