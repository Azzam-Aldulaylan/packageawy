import type { ReactElement, ReactNode } from 'react';

import type { SummaryFilterId, SummaryMetrics } from '../../../src/host/summaryMetrics.js';
import {
  attentionCardValue,
  updatesCardValue,
  vulnerabilitiesCardValue,
} from '../../../src/host/summaryMetrics.js';
import { InfoTooltip } from './Tooltip.js';
import type { ScanDataAvailability } from '../../../src/core/types.js';
import { IconAlertTriangle, IconBrand, IconShield, IconTrendUp } from '../icons.js';

interface CardSpec {
  id: SummaryFilterId;
  label: string;
  icon: ReactNode;
  count: number | string;
  subtitle: string;
}

function buildCards(metrics: SummaryMetrics, availability: ScanDataAvailability): CardSpec[] {
  const updates = updatesCardValue(metrics, availability);
  const vulnerabilities = vulnerabilitiesCardValue(metrics, availability);
  const attention = attentionCardValue(metrics, availability);
  return [
    {
      id: 'all',
      label: 'Total Dependencies',
      icon: <IconBrand />,
      count: metrics.total,
      subtitle: 'All direct dependencies',
    },
    {
      id: 'updates',
      label: 'Updates Available',
      icon: <IconTrendUp />,
      count: updates.count,
      subtitle: updates.subtitle,
    },
    {
      id: 'vulnerabilities',
      label: 'Affected packages',
      icon: <IconShield />,
      count: vulnerabilities.count,
      subtitle: vulnerabilities.subtitle,
    },
    {
      id: 'attention',
      label: 'Needs Attention',
      icon: <IconAlertTriangle />,
      count: attention.count,
      subtitle: attention.subtitle,
    },
  ];
}

function SummaryCard({
  card,
  selected,
  onSelect,
}: {
  card: CardSpec;
  selected: boolean;
  onSelect: (id: SummaryFilterId) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="summary-card"
      data-card={card.id}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={`${card.label}: ${card.count}. ${card.subtitle}`}
      onClick={() => {
        onSelect(card.id);
      }}
    >
      <span className="summary-card__body">
        <span className="summary-card__heading">
          <span className="summary-card__icon">{card.icon}</span>
          <span className="summary-card__label">{card.label}</span>
        </span>
        <span className="summary-card__count">{card.count}</span>
        <span className="summary-card__subtitle">{card.subtitle}</span>
      </span>
      <span className="summary-card__selection" aria-hidden="true">Viewing</span>
    </button>
  );
}

export function SummaryCards({
  metrics,
  availability,
  selected,
  onSelect,
}: {
  metrics: SummaryMetrics;
  availability: ScanDataAvailability;
  selected: SummaryFilterId;
  onSelect: (id: SummaryFilterId) => void;
}): ReactElement {
  const cards = buildCards(metrics, availability);
  return (
    <div className="summary-cards" role="group" aria-label="Filter dependencies by category">
      {cards.map((card) => (
        <div key={card.id} className={`summary-card-slot${card.id === 'vulnerabilities' ? ' summary-card-slot--with-help' : ''}`}>
          <SummaryCard card={card} selected={selected === card.id} onSelect={onSelect} />
          {card.id === 'vulnerabilities' ? (
            <InfoTooltip className="summary-card__help" label="About security counts" content={
              <dl>
                <dt>Affected packages</dt>
                <dd>Your direct dependencies affected by a known vulnerability, directly or through their own dependencies.</dd>
                <dt>Known vulnerabilities</dt>
                <dd>Separate published security reports that apply, counted once even when several packages reach them.</dd>
              </dl>
            } />
          ) : null}
        </div>
      ))}
    </div>
  );
}
