import { initializeApp, getApps } from "firebase/app";
import { getFirestore, Timestamp } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app, "day3");

/**
 * Recursively converts Firestore Timestamp fields to ISO strings
 * so objects can safely cross the server → client boundary.
 */
export function serialize<T>(obj: T): T {
  if (obj == null || typeof obj !== "object") return obj;
  if (obj instanceof Timestamp) return obj.toDate().toISOString() as unknown as T;
  if (Array.isArray(obj)) return obj.map(serialize) as unknown as T;
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    plain[key] = serialize(value);
  }
  return plain as T;
}
