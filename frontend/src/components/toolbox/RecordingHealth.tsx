import { useEffect, useState } from 'react';
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc';
import { GetToolboxHealth } from '../../../wailsjs/go/controller_app/App';
import type { models } from '../../../wailsjs/go/models';
import { errText } from '../../lib/errText';
import { humanAge } from '../../lib/time';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import { formatTime } from './history/format';
import { formatDuration, gapSeconds } from './history/gaps';
import { ATTRIBUTIONS } from './history/Attribution';

// A heartbeat older than this means the leader has stopped writing, even if
// the lease still names it.
const STALE_HEARTBEAT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = { label: string; tone: LampTone; value: string; note?: string };

/**
 * How well toolbox is recording, under the history tool's row: where its actor
 * information comes from, who is recording, what the last 7 days missed and
 * what is not recorded on purpose. Opens by itself when something is wrong.
 */
export default function RecordingHealth({ clusterName, refreshKey }: { clusterName: string; refreshKey: number }) {
    const t = useT();
    const [health, setHealth] = useState<models.ToolboxHealth | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<boolean | null>(null);

    useEffect(() => {
        let stale = false;
        GetToolboxHealth(clusterName)
            .then((h) => { if (!stale) { setHealth(h); setError(null); } })
            .catch((e) => { if (!stale) setError(errText(e)); });
        return () => { stale = true; };
    }, [clusterName, refreshKey]);

    const now = Date.now();
    const age = (iso?: string) => (iso ? t('panels:toolbox.health.ago', { age: humanAge(iso) }) : '');
    const rows: Row[] = [];
    if (health?.supported) {
        const { sources, leader, recorder, coverage, attribution, recording } = health;
        const source = (s: models.ToolboxSource, missingNote: string): Pick<Row, 'tone' | 'value' | 'note'> => {
            if (!s.enabled) return { tone: 'idle', value: t('panels:toolbox.health.off'), note: missingNote };
            if (!s.lastSeen) return { tone: 'warn', value: t('panels:toolbox.health.quiet'), note: missingNote };
            return { tone: 'ok', value: age(s.lastSeen) };
        };
        rows.push({ label: t('panels:toolbox.health.admission'), ...source(sources.admission, t('panels:toolbox.health.noAdmission')) });
        rows.push({ label: t('panels:toolbox.health.audit'), ...source(sources.audit, t('panels:toolbox.health.noAudit')) });

        const beatAge = recorder ? now - Date.parse(recorder.time) : Infinity;
        rows.push(!leader ? {
            label: t('panels:toolbox.health.leader'), tone: 'err', value: t('panels:toolbox.health.noLeader'),
        } : {
            label: t('panels:toolbox.health.leader'),
            tone: beatAge > STALE_HEARTBEAT_MS ? 'err' : 'ok',
            value: [
                leader.identity,
                leader.since ? t('panels:toolbox.health.leaderSince', { age: humanAge(leader.since) }) : '',
                recorder ? t('panels:toolbox.health.watching', { count: recorder.watchedResources }) : '',
            ].filter(Boolean).join(' · '),
            note: beatAge > STALE_HEARTBEAT_MS ? t('panels:toolbox.health.staleBeat', { age: recorder ? humanAge(recorder.time) : '—' }) : undefined,
        });

        const last = coverage.gaps[coverage.gaps.length - 1];
        const openGap = coverage.gaps.some((g) => g.open);
        const recentGap = coverage.gaps.some((g) => now - Date.parse(g.to) < DAY_MS);
        rows.push(!coverage.hasData ? {
            label: t('panels:toolbox.health.coverage'), tone: 'idle', value: t('panels:toolbox.health.noCoverage'),
        } : {
            label: t('panels:toolbox.health.coverage'),
            tone: openGap ? 'err' : recentGap ? 'warn' : 'ok',
            value: [
                // Rounded down: a week with a gap must never read as 100.0%.
                t('panels:toolbox.health.coverageRatio', { ratio: (Math.floor(coverage.ratio * 1000) / 10).toFixed(1) }),
                last ? t('panels:toolbox.health.lastGap', { age: humanAge(last.to), duration: formatDuration(gapSeconds(last)) })
                    : t('panels:toolbox.health.noGaps'),
            ].join(' · '),
            note: Date.parse(coverage.since) > now - 7 * DAY_MS + 60_000
                ? t('panels:toolbox.health.coverageSince', { since: formatTime(coverage.since) }) : undefined,
        });

        const total = attribution.reduce((n, c) => n + c.count, 0);
        rows.push({
            label: t('panels:toolbox.health.attribution'),
            tone: 'info',
            value: total === 0 ? t('panels:toolbox.health.noChanges') : ATTRIBUTIONS
                .map((k) => `${t(`panels:clusterHistory.via.${k}`)} ${Math.round(((attribution.find((c) => c.key === k)?.count ?? 0) / total) * 100)}%`)
                .join(' · '),
        });

        const excluded = [...recording.exclude, ...recording.excludeNamespaces.map((n) => `ns/${n}`)];
        rows.push({
            label: t('panels:toolbox.health.config'),
            tone: 'idle',
            value: [
                t('panels:toolbox.health.retention', { days: recording.changesRetentionDays }),
                t(recording.recordStatusChanges ? 'panels:toolbox.health.statusOn' : 'panels:toolbox.health.statusOff'),
                t('panels:toolbox.health.excluded', { count: excluded.length }),
            ].join(' · '),
            note: excluded.length ? excluded.join(', ') : undefined,
        });
    }

    // Open on its own the first time a problem shows; after that it is the
    // user's to toggle.
    const problem = !!error || rows.some((r) => r.tone === 'err' || r.tone === 'warn');
    useEffect(() => {
        if (open === null && (health || error)) setOpen(problem);
    }, [health, error, problem, open]);

    if (!health && !error) return null;
    const expanded = open ?? false;
    return (
        <div className="tool-health">
            <button type="button" className="tool-health__toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
                {expanded ? <VscChevronDown size={14} aria-hidden /> : <VscChevronRight size={14} aria-hidden />}
                {t('panels:toolbox.health.title')}
                {problem && <StatusLamp label={t('panels:toolbox.health.attention')} tone="warn" />}
            </button>
            {expanded && (
                error ? <p className="dlg-error tool-health__msg">{error}</p>
                    : !health?.supported ? <p className="tool-health__msg">{t('panels:toolbox.health.unsupported')}</p>
                        : (
                            <dl className="dlg-facts tool-health__facts">
                                {rows.map((r) => (
                                    <div className="dlg-facts__row" key={r.label}>
                                        <dt>{r.label}</dt>
                                        <dd>
                                            <StatusLamp label={r.value} tone={r.tone} />
                                            {r.note && <span className="tool-health__note" title={r.note}>{r.note}</span>}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        )
            )}
        </div>
    );
}
