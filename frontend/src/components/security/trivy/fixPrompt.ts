import type { models } from '../../../../wailsjs/go/models';
import type { TFn } from '../../../i18n/useT';

const MAX_IDS = 5;
const MAX_WORKLOADS = 5;

/** The text an "Ask AI" click leaves in the assistant's input for one fix-plan item. */
export function fixItemPrompt(item: models.TrivyFixItem, clusterName: string, t: TFn): string {
    const head = { cluster: clusterName, severity: item.severity };
    const lines: string[] = [];
    switch (item.kind) {
        case 'package':
            lines.push(t('panels:trivy.ai.promptPackage', {
                ...head, package: item.package, installed: item.installedVersion || '?',
                fixed: item.fixedVersion || '?', images: (item.images ?? []).join(', ') || item.image,
            }));
            break;
        case 'baseOS':
            lines.push(t('panels:trivy.ai.promptBaseOS', {
                ...head, image: item.image, os: [item.os?.family, item.os?.name].filter(Boolean).join(' '),
            }));
            if (item.os?.eosl) lines.push(t('panels:trivy.ai.promptEosl'));
            break;
        default:
            lines.push(t('panels:trivy.ai.promptMisconfig', {
                ...head, checkId: item.checkId, title: item.title, resolution: item.resolution || '-',
            }));
    }

    const ids = item.vulnIds ?? [];
    if (ids.length > 0) {
        const more = ids.length > MAX_IDS ? ` ${t('panels:trivy.ai.promptMore', { count: ids.length - MAX_IDS })}` : '';
        lines.push(t('panels:trivy.ai.promptVulns', { ids: ids.slice(0, MAX_IDS).join(', ') + more }));
    }

    const wls = item.workloads ?? [];
    if (wls.length > 0) {
        const more = wls.length > MAX_WORKLOADS ? ` ${t('panels:trivy.ai.promptMore', { count: wls.length - MAX_WORKLOADS })}` : '';
        lines.push(t('panels:trivy.ai.promptWorkloads', {
            list: wls.slice(0, MAX_WORKLOADS).map((w) => `${w.namespace}/${w.kind}/${w.name}`).join(', ') + more,
        }));
    }
    lines.push(t('panels:trivy.ai.promptClose'));
    return lines.join('\n');
}
