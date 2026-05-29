/**
 * Authorization checks for the order service.
 *
 * Each function emits an `auth_check` event into the active trace.
 * When this function is removed from the createOrder flow,
 * `tracegraph compare` raises a Critical finding automatically.
 *
 * ChildEventWriter.get() returns null when not running under `tracegraph run`,
 * so this is a transparent no-op in regular test and development runs.
 */
import { ChildEventWriter, writeEvent, currentParentEventId } from '@tracegraph/trace-js';
import { createEventId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';

export function assertCanPlaceOrder(customerId: string): void {
  const writer = ChildEventWriter.get();
  if (writer) {
    writeEvent({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId:       createEventId(),
      traceId:       writer.traceId,
      parentEventId: currentParentEventId(),
      type:          'auth_check',
      language:      'javascript',
      name:          'OrderPolicy.canPlace',
      eventName:     'OrderPolicy.canPlace',
      startTime:     Date.now(),
    });
  }

  // In production: verify JWT claims, check RBAC policy, account standing, etc.
  if (!customerId?.trim()) {
    const err = new Error('Unauthorized: customerId required');
    (err as Error & { status: number }).status = 401;
    throw err;
  }
}
