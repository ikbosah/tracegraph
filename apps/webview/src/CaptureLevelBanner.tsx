import React from 'react';
import type { CaptureLevel } from '@tracegraph/shared-types';

const LEVEL_RECOMMENDATIONS: Partial<Record<number, string>> = {
  0: 'Add @tracegraph/trace-js middleware to capture framework-level events.',
  1: 'Wrap business-critical functions with traceFunction() to capture logic flow.',
};

interface CaptureLevelBannerProps {
  captureLevel: CaptureLevel;
  onDismiss:    () => void;
}

export function CaptureLevelBanner({
  captureLevel,
  onDismiss,
}: CaptureLevelBannerProps): React.ReactElement {
  const rec = LEVEL_RECOMMENDATIONS[captureLevel.overall]
    ?? captureLevel.adapters?.express?.recommendation
    ?? 'Increase the capture level for richer traces.';

  return (
    <div className="capture-banner" role="status" aria-live="polite">
      <span className="capture-banner-icon">⚠</span>
      <span>
        <strong>Level {captureLevel.overall} — {captureLevel.label}.</strong>
        {' '}{rec}
      </span>
      <button
        className="capture-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss capture level warning"
      >
        ×
      </button>
    </div>
  );
}
