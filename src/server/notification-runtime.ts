import 'server-only';
import { SupabaseNotificationStore } from '../lib/notifications/store.js';
import { createPushSender } from '../lib/notifications/sender.js';
export const notificationStore = () => new SupabaseNotificationStore(process.env);
export const pushSender = () => createPushSender(process.env);
