---
description: View and edit Kubernetes Secrets in Kube Inspector with an automatic base64 decode/encode key-value editor.
---

# Secrets

The Secrets screen lists all `Secret` resources across namespaces.

## Columns

| Column | Description |
|---|---|
| Name | Secret name |
| Namespace | Namespace |
| Type | Secret type (e.g., `Opaque`, `kubernetes.io/tls`, `kubernetes.io/dockerconfigjson`) |
| Data Keys | Number of keys stored in the secret |

## Actions

### View / Edit YAML

Double-click a row to open the full Secret YAML. Secret values are **base64-encoded** in YAML — this is how Kubernetes stores them, not encryption.

### Key-Value Editor

Click the **sliders** icon on a row to open the key-value editor. It works like the [ConfigMap editor](configmaps.md#key-value-editor) — keys on the left, the value in a code editor on the right, a reviewed and dry-run save, and the workloads that use the Secret — with these differences:

- **Values stay hidden** until you click **Show value**, and hide again when you pick another key, switch tabs or save. **Copy value** copies without showing it. In the review, values are compared by size unless you ask to see them.
- **Base64 is handled for you.** Values are decoded for editing and encoded on save. A value that is not text (a keystore, a DER certificate) is kept byte for byte as a binary file; you can save it or replace it from a file, and it is never re-encoded by accident.
- **`kubernetes.io/tls`**: selecting `tls.crt` or `tls.key` shows the certificate's subject, issuer, names and expiry (▲ under 30 days, ■ expired) and whether the private key belongs to it.
- **`kubernetes.io/dockerconfigjson`**: the registry credentials appear as a form (registry, username, password, email); **Raw** switches to the JSON.

!!! danger "Sensitive data"
    A shown value is plain text on screen. Be careful when screen sharing.

### Bulk Delete

Select one or more secrets and click **Delete Selected**. Confirm in the dialog.

!!! warning
    Deleting a secret that is referenced by a pod (as an environment variable or volume) will cause that pod to fail when it is next scheduled or restarted.

## Secret Types

Common Kubernetes secret types you may encounter:

| Type | Usage |
|---|---|
| `Opaque` | Arbitrary user-defined key-value data |
| `kubernetes.io/tls` | TLS certificates (`tls.crt`, `tls.key`) |
| `kubernetes.io/dockerconfigjson` | Container registry credentials |
| `kubernetes.io/service-account-token` | Auto-generated service account token |

## Filtering

Use the filter row to search by name, namespace, type, or data key count. The **Data Keys** column supports numeric filtering — enter a number to find secrets with exactly that many keys.
