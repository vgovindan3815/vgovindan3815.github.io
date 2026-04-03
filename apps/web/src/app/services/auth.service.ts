import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type AuthRole = 'ADMIN' | 'FREIGHT_USER';
export type UserStatus = 'ACTIVE' | 'INACTIVE';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: AuthRole[];
  status: UserStatus;
  createdAt: string;
  lastLoginAt?: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  user?: AuthUser;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  roles: AuthRole[];
  status: UserStatus;
}

interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

const DEMO_USERS_STORAGE_KEY = 'freight.demo.users';
const DEMO_USERS: LocalDemoUser[] = [
  {
    id: 'user-admin',
    username: 'Admin',
    displayName: 'Admin',
    password: 'Admin@123',
    roles: ['ADMIN'],
    status: 'ACTIVE',
    createdAt: '2026-04-03T00:00:00.000Z',
  },
  {
    id: 'user-freight',
    username: 'freight_user',
    displayName: 'Freight User',
    password: 'Freight@123',
    roles: ['FREIGHT_USER'],
    status: 'ACTIVE',
    createdAt: '2026-04-03T00:00:00.000Z',
  },
];

type LocalDemoUser = AuthUser & { password: string };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly tokenKey = 'freight.auth.token';
  private readonly userKey = 'freight.auth.user';
  private readonly apiBaseUrl = environment.apiBaseUrl;
  private readonly userSubject = new BehaviorSubject<AuthUser | null>(null);

  readonly user$ = this.userSubject.asObservable();

  constructor() {
    if (!this.isBrowser()) {
      return;
    }

    this.userSubject.next(this.loadSessionUser());
    void this.validateSessionUser();
  }

  get user(): AuthUser | null {
    return this.userSubject.value;
  }

  isConfigured(): boolean {
    return false;
  }

  isAuthenticated(): boolean {
    return !!this.userSubject.value && !!this.getStoredToken();
  }

  hasAnyRole(roles: string[]): boolean {
    const currentRoles = this.user?.roles ?? [];
    return roles.some((role) => currentRoles.includes(role as AuthRole));
  }

  async login(username: string, password: string): Promise<LoginResult> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Login is only available in the browser.' };
    }

    if (environment.demoMode) {
      const users = this.readDemoUsers();
      const match = users.find(
        (user) =>
          user.username.toLowerCase() === username.trim().toLowerCase() &&
          user.password === password,
      );
      if (!match) {
        return { success: false, error: 'Invalid username or password.' };
      }
      if (match.status !== 'ACTIVE') {
        return { success: false, error: 'User is inactive. Contact an administrator.' };
      }

      const user: AuthUser = {
        id: match.id,
        username: match.username,
        displayName: match.displayName,
        roles: match.roles,
        status: match.status,
        createdAt: match.createdAt,
        lastLoginAt: new Date().toISOString(),
      };
      this.setSession(user, `demo-token-${user.id}`);

      const updatedUsers = users.map((u) =>
        u.id === user.id ? { ...u, lastLoginAt: user.lastLoginAt } : u,
      );
      this.writeDemoUsers(updatedUsers);
      return { success: true, user };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<AuthResponse>(`${this.apiBaseUrl}/api/auth/login`, {
          username,
          password,
        }),
      );

      this.setSession(response.user, response.accessToken);
      return { success: true, user: response.user };
    } catch (error) {
      const e = error as { error?: { error?: string } };
      return { success: false, error: e.error?.error ?? 'Login failed.' };
    }
  }

  logout(): void {
    if (!this.isBrowser()) {
      this.userSubject.next(null);
      return;
    }

    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    this.userSubject.next(null);
  }

  getAccount(): { username: string; name: string } | null {
    const user = this.user;
    if (!user) {
      return null;
    }

    return {
      username: user.username,
      name: user.displayName,
    };
  }

  async getToken(): Promise<string | null> {
    return this.getStoredToken();
  }

  async listUsers(): Promise<AuthUser[]> {
    if (environment.demoMode) {
      return this.readDemoUsers()
        .map(({ password: _password, ...user }) => user)
        .sort((left, right) => left.username.localeCompare(right.username));
    }

    const response = await firstValueFrom(
      this.http.get<AuthUser[]>(`${this.apiBaseUrl}/api/auth/users`, {
        headers: this.buildAuthHeaders(),
      }),
    );

    return response.sort((left, right) => left.username.localeCompare(right.username));
  }

  async createUser(input: CreateUserInput): Promise<LoginResult> {
    if (environment.demoMode) {
      const users = this.readDemoUsers();
      const exists = users.some(
        (user) => user.username.toLowerCase() === input.username.trim().toLowerCase(),
      );
      if (exists) {
        return { success: false, error: 'A user with this username already exists.' };
      }

      const created: LocalDemoUser = {
        id: `user-${Date.now()}`,
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        password: input.password,
        roles: [...input.roles],
        status: input.status,
        createdAt: new Date().toISOString(),
      };
      users.push(created);
      this.writeDemoUsers(users);

      const { password: _password, ...publicUser } = created;
      return { success: true, user: publicUser };
    }

    try {
      const created = await firstValueFrom(
        this.http.post<AuthUser>(`${this.apiBaseUrl}/api/auth/users`, input, {
          headers: this.buildAuthHeaders(),
        }),
      );

      return { success: true, user: created };
    } catch (error) {
      const e = error as { error?: { error?: string } };
      return { success: false, error: e.error?.error ?? 'Could not create the user.' };
    }
  }

  async updateUser(userId: string, changes: { status: UserStatus; password?: string }): Promise<LoginResult> {
    if (environment.demoMode) {
      const users = this.readDemoUsers();
      const idx = users.findIndex((user) => user.id === userId);
      if (idx < 0) {
        return { success: false, error: 'User not found.' };
      }

      const current = users[idx];
      users[idx] = {
        ...current,
        status: changes.status,
        password: changes.password?.trim() ? changes.password : current.password,
      };
      this.writeDemoUsers(users);

      const { password: _password, ...updated } = users[idx];
      if (this.user?.id === updated.id) {
        if (updated.status !== 'ACTIVE') {
          this.logout();
        } else {
          this.setSession(updated, this.getStoredToken() ?? `demo-token-${updated.id}`);
        }
      }

      return { success: true, user: updated };
    }

    try {
      const updated = await firstValueFrom(
        this.http.patch<AuthUser>(`${this.apiBaseUrl}/api/auth/users/${encodeURIComponent(userId)}`, changes, {
          headers: this.buildAuthHeaders(),
        }),
      );

      if (this.user?.id === updated.id) {
        if (updated.status !== 'ACTIVE') {
          this.logout();
        } else {
          this.setSession(updated, this.getStoredToken() ?? '');
        }
      }

      return { success: true, user: updated };
    } catch (error) {
      const e = error as { error?: { error?: string } };
      return { success: false, error: e.error?.error ?? 'Could not update the user.' };
    }
  }

  private isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  private setSession(user: AuthUser, token: string): void {
    if (!this.isBrowser()) {
      this.userSubject.next(user);
      return;
    }

    localStorage.setItem(this.tokenKey, token);
    localStorage.setItem(this.userKey, JSON.stringify(user));
    this.userSubject.next(user);
  }

  private loadSessionUser(): AuthUser | null {
    if (!this.isBrowser()) {
      return null;
    }

    const raw = localStorage.getItem(this.userKey);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  }

  private async validateSessionUser(): Promise<void> {
    const sessionUser = this.user;
    if (!sessionUser) {
      return;
    }

    if (environment.demoMode) {
      const users = this.readDemoUsers();
      const matched = users.find((user) => user.id === sessionUser.id);
      if (!matched || matched.status !== 'ACTIVE') {
        this.logout();
        return;
      }

      const { password: _password, ...publicUser } = matched;
      this.setSession(publicUser, this.getStoredToken() ?? `demo-token-${publicUser.id}`);
      return;
    }

    try {
      const refreshedUser = await firstValueFrom(
        this.http.get<AuthUser>(`${this.apiBaseUrl}/api/auth/me`, {
          headers: this.buildAuthHeaders(),
        }),
      );
      this.setSession(refreshedUser, this.getStoredToken() ?? '');
    } catch {
      this.logout();
    }
  }

  private getStoredToken(): string | null {
    if (!this.isBrowser()) {
      return null;
    }

    return localStorage.getItem(this.tokenKey);
  }

  private buildAuthHeaders(): HttpHeaders {
    let headers = new HttpHeaders();
    const token = this.getStoredToken();
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  }

  private readDemoUsers(): LocalDemoUser[] {
    if (!this.isBrowser()) {
      return DEMO_USERS;
    }

    const raw = localStorage.getItem(DEMO_USERS_STORAGE_KEY);
    if (!raw) {
      this.writeDemoUsers([...DEMO_USERS]);
      return [...DEMO_USERS];
    }

    try {
      const parsed = JSON.parse(raw) as LocalDemoUser[];
      if (!Array.isArray(parsed) || !parsed.length) {
        this.writeDemoUsers([...DEMO_USERS]);
        return [...DEMO_USERS];
      }
      return parsed;
    } catch {
      this.writeDemoUsers([...DEMO_USERS]);
      return [...DEMO_USERS];
    }
  }

  private writeDemoUsers(users: LocalDemoUser[]): void {
    if (!this.isBrowser()) {
      return;
    }
    localStorage.setItem(DEMO_USERS_STORAGE_KEY, JSON.stringify(users));
  }
}
