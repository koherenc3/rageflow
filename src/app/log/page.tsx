import type { Metadata } from 'next';
import { LogScreen } from '@/components/LogScreen';

export const metadata: Metadata = { title: 'Log - rageflow' };

export default function LogPage() {
  return <LogScreen />;
}
