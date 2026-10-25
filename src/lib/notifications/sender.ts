import webpush from 'web-push';
import type { Subscription, PushMessage } from './model.js';
export type PushSender = (subscription: Subscription, message: PushMessage) => Promise<void>;
export function createPushSender(env: Readonly<Record<string,string|undefined>>): PushSender {
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, privateKey = env.VAPID_PRIVATE_KEY, subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject || !/^(mailto:|https:\/\/)/.test(subject)) throw Error('VAPID_NOT_CONFIGURED');
  return async (subscription, message) => {
    await webpush.sendNotification(subscription, JSON.stringify(message), { vapidDetails:{ subject, publicKey, privateKey }, TTL:60, urgency:'high', timeout:10000 });
  };
}
/** Do not expose provider error bodies or capability endpoints. */
export function expiredSubscription(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'statusCode' in error && [404,410].includes(Number(error.statusCode));
}
