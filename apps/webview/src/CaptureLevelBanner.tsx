import React from 'react';
import type { CaptureLevel } from '@tracegraph/shared-types';

const LEVEL_RECOMMENDATIONS: Partial<Record<number, string>> = {
  0: 'Add @tracegraph/trace-js middleware to capture framework-level events.',
  1: 'Wrap business-critical functions with traceFunction() to capture logic flow.',
  2: 'Add traceTest() wrappers to your test suite for behaviour assertions.',
  3: 'Connect the TraceGraph Vitest reporter for full test-level tracing.',
  4: 'Enable database query tracing for complete data-layer visibility.',
  5: 'Full pipeline instrumented — all events are being captured.',
};

type BannerVariant = 'red' | 'amber' | 'green';

function getBannerVariant(level: number): BannerVariant {
  if (level >= 4) return 'green';
  if (level >= 2) return 'amber';
  return 'red';
}

const VARIANT_ICONS: Record<BannerVariant, string> = {
  red:   '✗',
  amber: '⚠',
  green: '✓',
};

interface CaptureLevelBannerProps {
  captureLevel: CaptureLevel;
  onDismiss:    () => void;
}

export function CaptureLevelBanner({
  captureLevel,
  onDismiss,
}: CaptureLevelBannerProps): React.ReactElement {
  const variant = getBannerVariant(captureLevel.overall);
  const icon    = VARIANT_ICONS[variant];
  const rec     = LEVEL_RECOMMENDATIONS[captureLevel.overall]
    ?? captureLevel.adapters?.express?.recommendation
    ?? 'Increase the capture level for richer traces.';

  return (
    <div
      className={`capture-banner capture-banner-${variant}`}
      role="status"
      aria-live="polite"
    >
      <span className="capture-banner-icon">{icon}</span>
      <span>
        <strong>Level {captureLevel.overall} — {captureLevel.label}.</strong>
        {' '}{rec}
      </span>
      <button
        className="capture-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss capture level notice"
      >
        ×
      </button>
    </div>
  );
}
