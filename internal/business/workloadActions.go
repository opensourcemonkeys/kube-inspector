package business

import (
	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

func ScaleWorkload(clusterName, kind, name, namespace string, replicas int32) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}
	return services.ScaleWorkload(kind, namespace, name, replicas, client)
}

func RestartWorkload(clusterName, kind, name, namespace string) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}
	return services.RestartWorkload(kind, namespace, name, client)
}

func SetCronJobSuspend(clusterName, name, namespace string, suspend bool) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}
	return services.SetCronJobSuspend(namespace, name, suspend, client)
}

// TriggerCronJob runs a CronJob once now and returns the created Job's name.
func TriggerCronJob(clusterName, name, namespace string) (string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return "", err
	}
	job, err := services.TriggerCronJob(namespace, name, client)
	if err != nil {
		logging.With("business.workloadActions").Error("trigger cronjob failed",
			"cluster", clusterName, "namespace", namespace, "name", name, "err", err)
		return "", err
	}
	logging.With("business.workloadActions").Info("cronjob triggered",
		"cluster", clusterName, "namespace", namespace, "name", name, "job", job)
	return job, nil
}

// GetWorkloadAutoscaler reports the HPA governing a workload, or nil when there
// is none.
//
// A failed lookup is deliberately swallowed. Listing HPAs is a separate RBAC
// verb the user may not hold, and autoscaling/v2 only exists from Kubernetes
// 1.23 — in both cases the answer is "we don't know", not "the scale should
// fail". The caller only uses this to decorate the scale dialog with a warning,
// so degrading to no warning is strictly better than blocking the action. Same
// reasoning as the optional metrics-server client in GetNodes.
func GetWorkloadAutoscaler(clusterName, kind, name, namespace string) (*models.HPAInfo, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	hpa, err := services.FindScaleAutoscaler(kind, namespace, name, client)
	if err != nil {
		logging.With("business.workloadActions").Debug("autoscaler lookup failed",
			"cluster", clusterName, "kind", kind, "namespace", namespace, "name", name, "err", err)
		return nil, nil
	}
	return hpa, nil
}
