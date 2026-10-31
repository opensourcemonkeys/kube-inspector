package business

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"kube-ins/internal/models"
)

// trivyHistoryKeep is how many saved scans are retained per cluster.
const trivyHistoryKeep = 20

const (
	trivyScanSuffix = ".json"
	trivyMetaSuffix = ".meta.json"
)

var (
	trivySafeID      = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
	trivyUnsafeChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)
	// exceptionsMu serialises read-modify-write of the exceptions files.
	exceptionsMu sync.Mutex
)

// trivySanitize makes a cluster name safe as a single path element.
func trivySanitize(name string) string {
	s := trivyUnsafeChars.ReplaceAllString(name, "_")
	if s == "" || s == "." || s == ".." {
		return "_"
	}
	return s
}

// trivyHistoryDir returns (creating it, mode 0700) the cluster's history directory.
func trivyHistoryDir(clusterName string) (string, error) {
	base, err := kubeInsDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "trivy-history", trivySanitize(clusterName))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// writeFileAtomic writes data to path via a temp file in the same directory.
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(name)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	ok = true
	return nil
}

// SaveTrivyScan persists a finished scan plus its meta summary, then prunes
// the cluster's history to the newest trivyHistoryKeep scans.
func SaveTrivyScan(scan *models.TrivyClusterScan, meta models.TrivyScanMeta) error {
	if scan == nil || !trivySafeID.MatchString(scan.ID) {
		return errors.New("invalid scan id")
	}
	dir, err := trivyHistoryDir(scan.ClusterName)
	if err != nil {
		return err
	}
	ts := time.Now().UTC()
	if t, err := time.Parse(time.RFC3339, scan.StartedAt); err == nil {
		ts = t.UTC()
	}
	base := filepath.Join(dir, ts.Format("20060102T150405Z")+"-"+scan.ID)
	data, err := json.Marshal(scan)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(base+trivyScanSuffix, data); err != nil {
		return err
	}
	mdata, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(base+trivyMetaSuffix, mdata); err != nil {
		_ = os.Remove(base + trivyScanSuffix)
		return err
	}
	pruneTrivyHistory(dir)
	return nil
}

// metaFiles returns the .meta.json file names in dir, newest first.
func metaFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && !strings.HasPrefix(e.Name(), ".") && strings.HasSuffix(e.Name(), trivyMetaSuffix) {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names
}

func pruneTrivyHistory(dir string) {
	names := metaFiles(dir)
	if len(names) <= trivyHistoryKeep {
		return
	}
	for _, n := range names[trivyHistoryKeep:] {
		stem := strings.TrimSuffix(n, trivyMetaSuffix)
		_ = os.Remove(filepath.Join(dir, stem+trivyScanSuffix))
		_ = os.Remove(filepath.Join(dir, n))
	}
}

// ListTrivyScans returns the saved scans' summaries, newest first. Unreadable
// or corrupt entries are skipped.
func ListTrivyScans(clusterName string) ([]models.TrivyScanMeta, error) {
	dir, err := trivyHistoryDir(clusterName)
	if err != nil {
		return nil, err
	}
	out := []models.TrivyScanMeta{}
	for _, n := range metaFiles(dir) {
		data, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		var m models.TrivyScanMeta
		if json.Unmarshal(data, &m) != nil || m.ID == "" {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// LoadTrivyScan reads one saved scan by id.
func LoadTrivyScan(clusterName, id string) (*models.TrivyClusterScan, error) {
	if !trivySafeID.MatchString(id) {
		return nil, fmt.Errorf("invalid scan id %q", id)
	}
	dir, err := trivyHistoryDir(clusterName)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || strings.HasSuffix(n, trivyMetaSuffix) || !strings.HasSuffix(n, "-"+id+trivyScanSuffix) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		var s models.TrivyClusterScan
		if err := json.Unmarshal(data, &s); err != nil {
			return nil, err
		}
		return &s, nil
	}
	return nil, fmt.Errorf("scan %q not found", id)
}

func trivyExceptionsPath(clusterName string) (string, error) {
	base, err := kubeInsDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "trivy-exceptions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(dir, trivySanitize(clusterName)+".json"), nil
}

func readExceptions(path string) ([]models.TrivyException, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []models.TrivyException{}, nil
	}
	if err != nil {
		return nil, err
	}
	var list []models.TrivyException
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	if list == nil {
		list = []models.TrivyException{}
	}
	return list, nil
}

func writeExceptions(path string, list []models.TrivyException) error {
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data)
}

// ListTrivyExceptions returns the cluster's accepted findings.
func ListTrivyExceptions(clusterName string) ([]models.TrivyException, error) {
	path, err := trivyExceptionsPath(clusterName)
	if err != nil {
		return nil, err
	}
	exceptionsMu.Lock()
	defer exceptionsMu.Unlock()
	return readExceptions(path)
}

// AddTrivyException validates and stores an exception, assigning ID and CreatedAt.
func AddTrivyException(clusterName string, e models.TrivyException) (models.TrivyException, error) {
	switch e.Kind {
	case "vuln":
		if strings.TrimSpace(e.VulnerabilityID) == "" || strings.TrimSpace(e.ImageRepo) == "" {
			return e, errors.New("a vulnerability exception needs a vulnerability id and an image repository")
		}
	case "misconfig":
		if strings.TrimSpace(e.CheckID) == "" || strings.TrimSpace(e.Workload.Name) == "" {
			return e, errors.New("a misconfiguration exception needs a check id and a workload")
		}
	default:
		return e, fmt.Errorf("exception kind %q is not supported", e.Kind)
	}
	if strings.TrimSpace(e.Reason) == "" {
		return e, errors.New("a reason is required")
	}
	if e.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, e.ExpiresAt)
		if err != nil {
			return e, fmt.Errorf("invalid expiry: %w", err)
		}
		if !t.After(time.Now()) {
			return e, errors.New("the expiry must be in the future")
		}
	}
	path, err := trivyExceptionsPath(clusterName)
	if err != nil {
		return e, err
	}
	exceptionsMu.Lock()
	defer exceptionsMu.Unlock()
	list, err := readExceptions(path)
	if err != nil {
		return e, err
	}
	e.ID = uuid.NewString()
	e.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := writeExceptions(path, append(list, e)); err != nil {
		return e, err
	}
	return e, nil
}

// RemoveTrivyException deletes an exception by id.
func RemoveTrivyException(clusterName, id string) error {
	path, err := trivyExceptionsPath(clusterName)
	if err != nil {
		return err
	}
	exceptionsMu.Lock()
	defer exceptionsMu.Unlock()
	list, err := readExceptions(path)
	if err != nil {
		return err
	}
	for i, x := range list {
		if x.ID == id {
			return writeExceptions(path, append(list[:i], list[i+1:]...))
		}
	}
	return fmt.Errorf("exception %q not found", id)
}
