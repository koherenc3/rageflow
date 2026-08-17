import type { Metadata } from 'next';
import { HistoryScreen } from '@/components/HistoryScreen';

export const metadata: Metadata = { title: 'History - rageflow' };

export default function HistoryPage() {
  return <HistoryScreen />;
}
