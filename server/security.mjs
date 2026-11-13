/**
 * Floodline - Security, Roles, Authentication, and Rate Limiting
 */

import 'dotenv/config';
import jwt from 'jsonwebtoken';

export const JWT_SECRET = process.env.JWT_SECRET || 'floodline-stormwater-jwt-secret-key-2026';
export const AGENT_BEARER_KEY = process.env.AGENT_BEARER_KEY || 'floodline-agent-key-2026';

export const USERS = [
  {
    username: 'operator',
    password: process.env.OPERATOR_PASSWORD || 'operator123',
    role: 'operator',
    displayName: 'Chief SCADA Operator'
  },
  {
    username: 'viewer',
    password: process.env.VIEWER_PASSWORD || 'viewer123',
    role: 'viewer',
    displayName: 'Basin Monitor (Read Only)'
  }
];

export function validateHostedCredentials(host) {
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return;
  if (process.env.DEMO_MODE !== 'false' ||
      (process.env.JWT_SECRET?.length ?? 0) < 32 ||
      (process.env.AGENT_BEARER_KEY?.length ?? 0) < 24 ||
      USERS.some(user => user.password.length < 12) ||
      USERS[0].password === USERS[1].password) {
    throw new Error('Network binding requires DEMO_MODE=false, a 32-character JWT_SECRET, a 24-character AGENT_BEARER_KEY, and distinct 12-character operator and viewer passwords.');
  }
}

export function createToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Express middleware to authenticate session via Bearer header or cookie.
 */
export function authenticate(req, res, next) {
  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies && req.cookies.floodline_token) {
    token = req.cookies.floodline_token;
  }

  if (!token) {
    // In local demo mode, if unauthenticated, grant operator session automatically for seamless evaluation
    const demoMode = process.env.DEMO_MODE !== 'false';
    if (demoMode) {
      req.user = { username: 'demo-operator', role: 'operator', displayName: 'Demo Operator (Auto)' };
      return next();
    }
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  // Check if token is the agent bearer key
  if (token === AGENT_BEARER_KEY) {
    req.user = { username: 'telemetry-agent', role: 'agent', displayName: 'Ingest Agent' };
    return next();
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }

  req.user = decoded;
  next();
}

/**
 * Middleware ensuring user has at least one of the allowed roles.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: role '${req.user.role}' is not authorized for this action. Required: ${roles.join(' or ')}`
      });
    }
    next();
  };
}

/**
 * Specialized authenticate middleware for POST /api/ingest
 * Accepts either valid Agent Bearer key or logged-in Operator.
 */
export function authenticateIngest(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies && req.cookies.floodline_token) {
    token = req.cookies.floodline_token;
  }

  if (token === AGENT_BEARER_KEY) {
    req.user = { username: 'telemetry-agent', role: 'agent', displayName: 'Ingest Agent' };
    return next();
  }

  if (token) {
    const decoded = verifyToken(token);
    if (decoded && (decoded.role === 'operator' || decoded.role === 'agent')) {
      req.user = decoded;
      return next();
    }
  }

  // In demo mode, permit ingest if demo mode active
  if (process.env.DEMO_MODE !== 'false' && !authHeader) {
    req.user = { username: 'demo-operator', role: 'operator', displayName: 'Demo Operator' };
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Telemetry ingestion requires a valid Agent Bearer key or Operator session'
  });
}

/**
 * Token Bucket Rate Limiter
 * Enforces request rate and event throughput limits per client/agent.
 */
export class TokenBucketRateLimiter {
  constructor({ capacity = 100, refillRate = 20, eventCapacity = 2000, eventRefillRate = 1000 } = {}) {
    this.capacity = capacity; // Max burst requests
    this.refillRate = refillRate; // Tokens added per second
    this.eventCapacity = eventCapacity; // Max burst events
    this.eventRefillRate = eventRefillRate; // Event tokens added per second
    this.buckets = new Map();
  }

  _getBucket(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        tokens: this.capacity,
        eventTokens: this.eventCapacity,
        lastRefill: now
      };
      this.buckets.set(key, b);
      return b;
    }

    const elapsedSec = (now - b.lastRefill) / 1000;
    if (elapsedSec > 0) {
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillRate);
      b.eventTokens = Math.min(this.eventCapacity, b.eventTokens + elapsedSec * this.eventRefillRate);
      b.lastRefill = now;
    }

    // Clean up old buckets periodically if map gets huge
    if (this.buckets.size > 10000) {
      const cutoff = now - 60000;
      for (const [k, v] of this.buckets.entries()) {
        if (v.lastRefill < cutoff) this.buckets.delete(k);
      }
    }

    return b;
  }

  /**
   * Tries to consume tokens.
   * @param {string} key
   * @param {number} eventCount
   * @returns {{ allowed: boolean, retryAfterSec?: number, reason?: string }}
   */
  tryConsume(key, eventCount = 1) {
    const b = this._getBucket(key);

    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / this.refillRate);
      return { allowed: false, retryAfterSec: Math.max(1, retryAfter), reason: 'Request rate limit exceeded' };
    }

    if (b.eventTokens < eventCount) {
      const retryAfter = Math.ceil((eventCount - b.eventTokens) / this.eventRefillRate);
      return { allowed: false, retryAfterSec: Math.max(1, retryAfter), reason: 'Event throughput volume limit exceeded' };
    }

    b.tokens -= 1;
    b.eventTokens -= eventCount;
    return { allowed: true };
  }
}
