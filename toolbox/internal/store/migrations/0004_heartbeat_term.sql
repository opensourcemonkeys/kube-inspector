-- Each leader term (one run of the watchers, from becoming leader to losing
-- it or exiting) gets its own ID. A new term starts its informers from a
-- fresh list, which is never recorded as changes, so whatever happened
-- between the previous term's last heartbeat and this one's first is missed:
-- a change of term is a recording gap however short. Rows from before this
-- column share the empty term.
ALTER TABLE recorder_heartbeats ADD COLUMN IF NOT EXISTS term String DEFAULT '';
