---
description: View and edit Kubernetes ConfigMaps in Kube Inspector with a friendly key-value editor — no manual YAML wrangling required.
---

# ConfigMaps

The ConfigMaps screen lists all `ConfigMap` resources across namespaces.

## Columns

| Column | Description |
|---|---|
| Name | ConfigMap name |
| Namespace | Namespace |
| Data Keys | Number of key-value pairs in the ConfigMap |
| Age | Time since creation |

## Actions

### View / Edit YAML

Double-click a row to open the full ConfigMap YAML in an editor panel. Make changes and click **Apply** to update.

### Key-Value Editor

Click the **sliders** icon on a row to open the key-value editor. The keys are listed on the left; the selected key's value opens on the right in a full code editor, so a whole `application.yaml` or `nginx.conf` is as easy to edit as a one-word setting.

- **Syntax and checks.** The value is highlighted by the key's extension (`.yaml`, `.conf`/`.properties`/`.ini`, `.sh`, `.xml`). A `.yaml` or `.json` value that does not parse is underlined at the broken line.
- **What you changed.** Each key is marked: **+** new, **●** changed, **−** removed (until you save, a removed key can be restored). A key name the API server would refuse — a space, a duplicate — is marked **⚠** and blocks the save.
- **Files.** **Add from file** creates a key from a file, named after it. On any key you can **Replace from file** or **Save to file**. Binary values (`binaryData`) are kept as files and never shown as text.
- **Used by.** Under the key list, the workloads whose pods use this ConfigMap, and how (`env`, `envFrom`, a mount path). Click one to open its Describe panel.

### Review and save

**Review and save** (or **Ctrl+S**) opens the changes key by key, with a diff of each value. The API server checks the exact write with a **dry run** first; Save stays off until it passes.

- If someone else changed the ConfigMap after you opened it, the save is refused instead of overwriting their change. Choose **Apply mine to the latest** to replay your changes onto the current version, or reload and start over.
- Workloads that read the ConfigMap only when their containers start (`env`, `envFrom` or a `subPath` mount) keep the old values. After the save you are offered a rolling restart of those Deployments, StatefulSets and DaemonSets. Volume mounts update on their own within a minute or so.

Closing or moving the tab with unsaved changes asks first.

### Bulk Delete

Select one or more ConfigMaps and click **Delete Selected**. Confirm in the dialog.

!!! warning
    Deleting a ConfigMap that is mounted by running pods does not immediately affect those pods — the mounted values are cached. However, pods that restart after deletion will fail to start if the ConfigMap is required.

## Filtering

Use the filter row under each column header to search by name, namespace, or data key count.
