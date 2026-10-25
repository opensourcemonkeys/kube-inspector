kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: __AUDIT_DIR__
        containerPath: /etc/kubernetes/audit
        readOnly: true
    kubeadmConfigPatches:
      - |
        kind: ClusterConfiguration
        apiServer:
          extraArgs:
            audit-policy-file: /etc/kubernetes/audit/policy.yaml
            audit-webhook-config-file: /etc/kubernetes/audit/webhook.yaml
            audit-webhook-batch-max-wait: 2s
          extraVolumes:
            - name: audit
              hostPath: /etc/kubernetes/audit
              mountPath: /etc/kubernetes/audit
              readOnly: true
              pathType: Directory
