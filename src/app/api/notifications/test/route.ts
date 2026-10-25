import { notificationStore, pushSender } from '../../../../server/notification-runtime.js';
import { createTestNotificationHandler } from '../../../../server/test-notification-handler.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createTestNotificationHandler(notificationStore, pushSender);
