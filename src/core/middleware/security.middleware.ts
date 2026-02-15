import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Security Middleware
 *
 * Configures security headers for the application, including:
 * 1. Content Security Policy (CSP) for Shopify embedding
 * 2. CORS headers
 * 3. Other security best practices
 *
 * CRITICAL: CSP must allow iframe embedding in Shopify Admin
 */

@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SecurityMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    // Set Content Security Policy
    // IMPORTANT: Must allow frame-ancestors for Shopify embedding
    this.setCSPHeaders(res);

    // Set CORS headers
    this.setCORSHeaders(res, req);

    // Set other security headers
    this.setSecurityHeaders(res);

    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    next();
  }

  /**
   * Content Security Policy
   *
   * Allows the app to be embedded in Shopify Admin iframe
   * while maintaining security for other resources
   */
  private setCSPHeaders(res: Response) {
    const cspDirectives = [
      // Allow embedding in Shopify Admin
      "frame-ancestors 'self' https://admin.shopify.com https://*.myshopify.com",

      // Default source: only same origin
      "default-src 'self'",

      // Scripts: self + inline (needed for some UI frameworks)
      // In production, consider using nonces instead of 'unsafe-inline'
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.shopify.com https://cdnjs.cloudflare.com",

      // Styles: self + inline (needed for component libraries)
      "style-src 'self' 'unsafe-inline' https://cdn.shopify.com https://fonts.googleapis.com",

      // Images: self + data URIs + external sources
      "img-src 'self' data: https: blob:",

      // Fonts
      "font-src 'self' data: https://fonts.gstatic.com",

      // Connect (API calls): self + your API domain
      "connect-src 'self' https://api.shopify.com wss://cdn.shopify.com",

      // Frames: self + Shopify (for OAuth redirects)
      "frame-src 'self' https://admin.shopify.com https://*.myshopify.com",
    ];

    res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

    this.logger.debug('CSP headers set for Shopify embedding');
  }

  /**
   * CORS Headers
   *
   * Configure CORS for API access from frontend
   */
  private setCORSHeaders(res: Response, req: Request) {
    const origin = req.headers.origin;
    const allowedOrigins = this.getAllowedOrigins();

    // Check if origin is allowed
    if (origin && this.isOriginAllowed(origin, allowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, ngrok-skip-browser-warning, x-shopify-access-token',
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  }

  /**
   * Resolve allowed origins from env with safe defaults.
   *
   * - `CORS_ALLOWED_ORIGINS`: comma-separated list, supports `*`
   * - falls back to sensible dev/prod defaults
   */
  private getAllowedOrigins(): string[] {
    const envOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (envOrigins && envOrigins.length > 0) {
      return envOrigins;
    }

    const defaults =
      process.env.NODE_ENV === 'production'
        ? ['https://admin.shopify.com', 'https://akeed-eta.vercel.app']
        : ['*'];

    if (process.env.APP_URL) {
      defaults.push(process.env.APP_URL.trim());
    }

    return [...new Set(defaults)];
  }

  /**
   * Additional Security Headers
   */
  private setSecurityHeaders(res: Response) {
    // DO NOT USE X-Frame-Options - it conflicts with CSP frame-ancestors
    // If you must set it, use ALLOW-FROM, but CSP is preferred
    // res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Enable XSS protection
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions policy (formerly Feature-Policy)
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=()',
    );

    // HSTS (HTTP Strict Transport Security)
    // Only enable in production with HTTPS
    if (process.env.NODE_ENV === 'production') {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
  }

  /**
   * Check if origin is allowed
   */
  private isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
    if (allowedOrigins.includes('*')) {
      return true;
    }

    // Exact match
    if (allowedOrigins.includes(origin)) {
      return true;
    }

    // Pattern match for Shopify stores (*.myshopify.com)
    if (origin.match(/^https:\/\/[a-zA-Z0-9-]+\.myshopify\.com$/)) {
      return true;
    }

    return false;
  }
}
