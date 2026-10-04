// Tiny GraphQL client for Vendure's Admin and Shop APIs, bearer-token sessions.
export const VENDURE_URL = process.env.VENDURE_URL ?? 'http://localhost:3000';

export class Session {
  token?: string;
  readonly api: 'admin-api' | 'shop-api';
  constructor(api: 'admin-api' | 'shop-api') {
    this.api = api;
  }
  async q<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${VENDURE_URL}/${this.api}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    const token = res.headers.get('vendure-auth-token');
    if (token) this.token = token;
    const body = await res.json();
    if (body.errors?.length) throw new Error(`${this.api}: ${body.errors.map((e: any) => e.message).join('; ')}`);
    return body.data;
  }
}

// Mutations return error results as union members with errorCode/message.
export function ok<T extends Record<string, any>>(r: T, what: string): T {
  if (r && typeof r === 'object' && 'errorCode' in r) throw new Error(`${what}: ${r.errorCode} ${r.message}`);
  return r;
}

export async function admin(username = 'superadmin', password = process.env.SUPERADMIN_PASSWORD ?? 'superadmin') {
  const s = new Session('admin-api');
  ok((await s.q(`mutation($u:String!,$p:String!){ login(username:$u,password:$p){ ... on CurrentUser { id } ... on ErrorResult { errorCode message } } }`, { u: username, p: password })).login, 'admin login');
  return s;
}
