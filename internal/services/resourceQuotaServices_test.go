package services_k8sclient

import (
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"
)

func TestNewQuotaEntryRemaining(t *testing.T) {
	cases := []struct {
		resource, hard, used, remaining string
		hardNum, usedNum                int64
	}{
		{"requests.cpu", "4", "1500m", "2500m", 4000, 1500},
		{"limits.memory", "8Gi", "3Gi", "5Gi", 8 << 30, 3 << 30},
		{"pods", "10", "10", "0", 10, 10},
		// A quota lowered below current usage: the overshoot is information.
		{"services", "2", "3", "-1", 2, 3},
		// Status.Used has no entry yet for a freshly created quota.
		{"configmaps", "5", "0", "5", 5, 0},
	}
	for _, c := range cases {
		e := newQuotaEntry(c.resource, resource.MustParse(c.hard), resource.MustParse(c.used))
		if e.Remaining != c.remaining {
			t.Errorf("%s: remaining = %q, want %q", c.resource, e.Remaining, c.remaining)
		}
		if e.HardNum != c.hardNum || e.UsedNum != c.usedNum {
			t.Errorf("%s: nums = %d/%d, want %d/%d", c.resource, e.UsedNum, e.HardNum, c.usedNum, c.hardNum)
		}
		if e.Hard != c.hard || e.Used != c.used {
			t.Errorf("%s: hard/used = %q/%q, want %q/%q", c.resource, e.Hard, e.Used, c.hard, c.used)
		}
	}
}

// A missing Status.Used key yields the zero Quantity; Remaining must still be
// the hard value rather than panicking or printing an empty string.
func TestNewQuotaEntryZeroUsed(t *testing.T) {
	e := newQuotaEntry("pods", resource.MustParse("10"), resource.Quantity{})
	if e.Remaining != "10" || e.Used != "0" {
		t.Fatalf("got used=%q remaining=%q", e.Used, e.Remaining)
	}
}
