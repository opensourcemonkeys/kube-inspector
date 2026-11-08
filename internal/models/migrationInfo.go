package models

// MigrationSchemaVersion is the version of a saved MigrationRecord.
const MigrationSchemaVersion = 1

// Migration phases, as stored in MigrationRecord.Phase.
const (
	MigrationPreparing = "preparing"
	MigrationCopying   = "copying"
	MigrationReady     = "ready"
	MigrationCutover   = "cutover"
	MigrationDone      = "done"
	MigrationFailed    = "failed"
	MigrationCancelled = "cancelled"
)

// MigrationRequest is what the user chose. StorageClasses maps a source class
// to a target class ("" is a claim with no class, or the target's default).
// Decisions maps a conflict's Key to "skip" or "overwrite"; a conflict with no
// decision is skipped.
type MigrationRequest struct {
	Source         string            `json:"source"`
	Target         string            `json:"target"`
	Namespaces     []string          `json:"namespaces"`
	StorageClasses map[string]string `json:"storageClasses"`
	Decisions      map[string]string `json:"decisions"`
	BandwidthKBps  int               `json:"bandwidthKBps"`
	MoverImage     string            `json:"moverImage"`
}

// MigrationObject names one object a migration carries over.
type MigrationObject struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// MigrationIssue is one finding of the preflight. Code is translated by the
// frontend; Detail is the underlying text. A Blocker stops the migration.
type MigrationIssue struct {
	Code      string `json:"code"`
	Blocker   bool   `json:"blocker"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// MigrationConflict is an object that already exists on the target. Secret
// values are hashed in both YAMLs.
type MigrationConflict struct {
	Key        string `json:"key"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	IsPVC      bool   `json:"isPvc"`
	SourceYaml string `json:"sourceYaml"`
	TargetYaml string `json:"targetYaml"`
}

// MigrationSkipped is an object that is not carried over, and why (a code).
type MigrationSkipped struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Reason    string `json:"reason"`
}

// MigrationMissing is a cluster-scoped object the target lacks. It is reported,
// never created.
type MigrationMissing struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	UsedBy string `json:"usedBy"`
}

// MigrationDisk is one PersistentVolumeClaim of a migration. Copy is false for a
// claim whose data does not move (not bound, or the user kept the target's).
// LiveCopy is false when it cannot be read while the application runs.
type MigrationDisk struct {
	Namespace   string   `json:"namespace"`
	Name        string   `json:"name"`
	Size        string   `json:"size"`
	SourceClass string   `json:"sourceClass"`
	TargetClass string   `json:"targetClass"`
	AccessModes []string `json:"accessModes"`
	Copy        bool     `json:"copy"`
	LiveCopy    bool     `json:"liveCopy"`
}

// MigrationPreflight is the answer of the preflight.
type MigrationPreflight struct {
	Objects       []MigrationObject   `json:"objects"`
	Disks         []MigrationDisk     `json:"disks"`
	Conflicts     []MigrationConflict `json:"conflicts"`
	Issues        []MigrationIssue    `json:"issues"`
	Skipped       []MigrationSkipped  `json:"skipped"`
	Missing       []MigrationMissing  `json:"missing"`
	TargetClasses []string            `json:"targetClasses"`
}

// MigrationWorkload is a source workload as it was before the migration.
type MigrationWorkload struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Replicas  int32  `json:"replicas"`
}

// MigrationCronJob is a source CronJob as it was before the migration.
type MigrationCronJob struct {
	Namespace    string `json:"namespace"`
	Name         string `json:"name"`
	WasSuspended bool   `json:"wasSuspended"`
}

// MigrationDiskRun is what is known about copying one disk.
type MigrationDiskRun struct {
	MigrationDisk
	Index       int    `json:"index"`
	Passes      int    `json:"passes"`
	LastPassAt  string `json:"lastPassAt,omitempty"`
	BytesCopied int64  `json:"bytesCopied"`
	Error       string `json:"error,omitempty"`
}

// MigrationRecord is a migration as saved under ~/.kube-ins/migrations: raw
// facts, never Secret values or keys. What the screens show is computed from it.
type MigrationRecord struct {
	SchemaVersion    int                 `json:"schemaVersion"`
	ID               string              `json:"id"`
	Source           string              `json:"source"`
	Target           string              `json:"target"`
	Namespaces       []string            `json:"namespaces"`
	Phase            string              `json:"phase"`
	Step             string              `json:"step,omitempty"`
	Error            string              `json:"error,omitempty"`
	CreatedAt        string              `json:"createdAt"`
	CutoverStartedAt string              `json:"cutoverStartedAt,omitempty"`
	CutoverEndedAt   string              `json:"cutoverEndedAt,omitempty"`
	StorageClasses   map[string]string   `json:"storageClasses,omitempty"`
	Decisions        map[string]string   `json:"decisions,omitempty"`
	BandwidthKBps    int                 `json:"bandwidthKBps,omitempty"`
	MoverImage       string              `json:"moverImage"`
	Objects          []MigrationObject   `json:"objects"`
	Skipped          []MigrationSkipped  `json:"skipped"`
	Disks            []MigrationDiskRun  `json:"disks"`
	Workloads        []MigrationWorkload `json:"workloads"`
	CronJobs         []MigrationCronJob  `json:"cronJobs"`
}

// MigrationDiskProgress is one disk's live state.
type MigrationDiskProgress struct {
	MigrationDiskRun
	Running bool   `json:"running"`
	Percent int    `json:"percent"`
	Rate    string `json:"rate,omitempty"`
}

// MigrationProgress is the live state of a migration, pushed as
// migration:progress:{id}. Interrupted means a final switch stopped part-way
// and is waiting for the user to continue it.
type MigrationProgress struct {
	ID          string                  `json:"id"`
	Source      string                  `json:"source"`
	Target      string                  `json:"target"`
	Phase       string                  `json:"phase"`
	Step        string                  `json:"step,omitempty"`
	Error       string                  `json:"error,omitempty"`
	Interrupted bool                    `json:"interrupted"`
	Disks       []MigrationDiskProgress `json:"disks"`
}

// MigrationMeta is one line of the list of past migrations.
type MigrationMeta struct {
	ID         string   `json:"id"`
	Source     string   `json:"source"`
	Target     string   `json:"target"`
	Namespaces []string `json:"namespaces"`
	Phase      string   `json:"phase"`
	CreatedAt  string   `json:"createdAt"`
}

// MigrationWorkloadState is a workload as it stands on the target.
type MigrationWorkloadState struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Ready     int32  `json:"ready"`
	Desired   int32  `json:"desired"`
	Reason    string `json:"reason,omitempty"`
}

// MigrationDiskState is a claim as it stands on the target.
type MigrationDiskState struct {
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	Size        string `json:"size"`
	SourceClass string `json:"sourceClass"`
	TargetClass string `json:"targetClass"`
	Status      string `json:"status"`
	Copied      bool   `json:"copied"`
	BytesCopied int64  `json:"bytesCopied"`
}

// MigrationAddress is where traffic for the migrated namespaces can be sent.
type MigrationAddress struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Host      string `json:"host,omitempty"`
	Address   string `json:"address,omitempty"`
}

// MigrationResult is the status screen: the record joined with the two
// clusters as they are now.
type MigrationResult struct {
	ID              string                   `json:"id"`
	Source          string                   `json:"source"`
	Target          string                   `json:"target"`
	Phase           string                   `json:"phase"`
	Error           string                   `json:"error,omitempty"`
	Namespaces      []string                 `json:"namespaces"`
	ObjectCount     int                      `json:"objectCount"`
	BytesCopied     int64                    `json:"bytesCopied"`
	DowntimeSeconds int64                    `json:"downtimeSeconds"`
	Workloads       []MigrationWorkloadState `json:"workloads"`
	Disks           []MigrationDiskState     `json:"disks"`
	Addresses       []MigrationAddress       `json:"addresses"`
	Skipped         []MigrationSkipped       `json:"skipped"`
	SourceStopped   bool                     `json:"sourceStopped"`
	// LiveError says the clusters could not be read just now; what is shown
	// comes from the record only.
	LiveError string `json:"liveError,omitempty"`
}
