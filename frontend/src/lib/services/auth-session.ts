import { apiJson } from './http';
import { clearSession } from '../stores/auth';

export async function logoutSession() {
  await apiJson('/api/logout', { method: 'POST' });
  clearSession();
}
