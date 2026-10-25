import 'server-only';
import { createCollectorHandler } from '../../../../../server/collector-handler.js';
import { runCollection } from '../../../../../server/collector-runtime.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const POST = createCollectorHandler(() => process.env.COMMUTEGUARD_CRON_SECRET, runCollection);
