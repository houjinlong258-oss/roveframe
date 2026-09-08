'use client';

import { useEffect } from 'react';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Web Push 订阅：注册 Service Worker + 持久化 push 订阅。
 * 静默挂载于管理后台 AppShell；订阅写入 push_subscriptions 表，
 * 出件时仅向 owner 的订阅投递（dispatchWebPushToBusiness 限定）。
 */
export function PushSubscribe() {
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const publicKey = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
      if (!publicKey) return;
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        if (!cancelled) await navigator.serviceWorker.ready;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }
        const body = {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.toJSON().keys?.p256dh, auth: subscription.toJSON().keys?.auth },
        };
        await fetch('/api/notifications/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        console.warn('[push] subscription setup failed:', error instanceof Error ? error.message : String(error));
      }
    }
    void run();
    return () => { cancelled = true; };
  }, []);

  return null;
}
