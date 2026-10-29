{{/*
The name objects and labels are built from. Deliberately not .Chart.Name: the
chart is published as kube-inspector-toolbox, but Kube Inspector finds the
collector by app.kubernetes.io/name=toolbox and installs from before the
rename have objects named toolbox, so renaming the chart must not rename them.
*/}}
{{- define "toolbox.name" -}}
{{- default "toolbox" .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "toolbox.fullname" -}}
{{- $name := include "toolbox.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "toolbox.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{ include "toolbox.selectorLabels" . }}
{{- end -}}

{{- define "toolbox.selectorLabels" -}}
app.kubernetes.io/name: {{ include "toolbox.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: collector
{{- end -}}

{{- define "toolbox.clickhouse.fullname" -}}
{{- printf "%s-clickhouse" (include "toolbox.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "toolbox.clickhouse.selectorLabels" -}}
app.kubernetes.io/name: {{ include "toolbox.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: clickhouse
{{- end -}}

{{- define "toolbox.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "toolbox.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "toolbox.auditServiceName" -}}
{{- printf "%s-audit" (include "toolbox.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "toolbox.tlsSecretName" -}}
{{- printf "%s-tls" (include "toolbox.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A secret value that is generated once and then kept: the value set in
values.yaml, else the one already in the cluster, else a random one.
Usage: include "toolbox.persistentSecret" (dict "ctx" . "key" "api-token" "value" .Values.apiToken)
*/}}
{{- define "toolbox.persistentSecret" -}}
{{- if .value -}}
{{- .value -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace (include "toolbox.fullname" .ctx) -}}
{{- if and $existing (index $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}
{{- randAlphaNum 40 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "toolbox.clickhouse.addr" -}}
{{- if .Values.clickhouse.enabled -}}
{{- list (printf "%s.%s.svc:9000" (include "toolbox.clickhouse.fullname" .) .Release.Namespace) | toJson -}}
{{- else -}}
{{- required "externalClickhouse.addr is required when clickhouse.enabled is false" .Values.externalClickhouse.addr | toJson -}}
{{- end -}}
{{- end -}}
