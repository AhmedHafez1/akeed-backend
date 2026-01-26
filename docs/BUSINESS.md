# Akeed - Business Capabilities Documentation

## Executive Summary

**Akeed** is a multi-tenant SaaS platform that automates Cash on Delivery (COD) order verification for e-commerce businesses. The platform integrates with multiple e-commerce platforms (currently Shopify, with WooCommerce in development) and uses WhatsApp messaging to verify orders with customers before fulfillment, reducing failed deliveries, return rates, and operational costs.

---

## Core Value Proposition

### Problem Statement

E-commerce businesses face significant challenges with COD orders:

- High return rates (30-50% in some markets)
- Failed delivery attempts costing money and time
- Fake orders placed with incorrect phone numbers
- Wasted resources on order fulfillment and logistics

### Solution

Akeed automates the order verification process by:

1. **Intercepting** new COD orders from e-commerce platforms
2. **Sending** automated WhatsApp verification messages to customers
3. **Collecting** customer confirmations or cancellations via interactive messages
4. **Updating** order status in the source platform automatically

---

## Business Capabilities

### 1. Multi-Platform E-Commerce Integration

#### Shopify Integration

- **OAuth Authentication**: Secure app installation flow for Shopify stores
- **Webhook Registration**: Production-grade, idempotent registration of Shopify webhooks
  - Topics: `orders/create` and `app/uninstalled`
  - Uses configured Admin API version, includes `X-Shopify-Access-Token`
  - Idempotent: treats HTTP 422 (already exists) as success; safe on reinstall
  - Non-blocking OAuth callback: registration runs in background to avoid delaying redirect
  - Reliability: retry with exponential backoff for transient failures; logs topic + shop
- **Webhook Management**: Real-time order event processing
- **Order Data Synchronization**: Automatic capture of order details including:
  - Order ID and order number
  - Customer information (name, phone, shipping address)
  - Order total and currency
  - Product line items
- **Bidirectional Communication**: Updates Shopify orders with verification tags
  - `Akeed: Verified` - Customer confirmed the order
  - `Akeed: Canceled` - Customer canceled via WhatsApp
- **App Lifecycle Management**: Handles installation and uninstallation events

#### WooCommerce Integration (In Development)

- Platform connector architecture ready for WooCommerce stores
- Similar webhook and data synchronization capabilities

#### Multi-Tenant Architecture

- Each merchant operates in an isolated organization workspace
- Secure data separation between different businesses
- Role-based access control (Owner, Admin, Viewer)

---

### 2. WhatsApp Cloud API Integration

#### Automated Messaging

- **Verification Templates**: Pre-approved Meta Business templates for:
  - Order confirmation requests
  - Order details presentation
  - Payment information
- **Interactive Messages**: Rich messaging with action buttons
  - "Confirm Order" button
  - "Cancel Order" button
  - Real-time response handling

#### Two-Way Communication

- **Webhook Processing**: Receives customer responses from WhatsApp
- **Status Tracking**: Monitors message delivery, read receipts, and responses
- **Customer Interaction History**: Maintains complete message thread per order

#### Compliance & Reliability

- Meta Business API compliant messaging
- Template approval workflow support
- Automatic retry mechanisms for failed messages
- Message ID tracking for audit trails

---

### 3. Order Verification Workflow

#### Intelligent Order Processing

1. **Order Reception**
   - Receives webhooks from integrated platforms
   - Validates and normalizes order data across platforms
   - Prevents duplicate processing (idempotent operations)

2. **Verification Record Creation**
   - Creates verification records linked to orders
   - Tracks verification status lifecycle:
     - `pending` - Verification created, message queued
     - `sent` - WhatsApp message delivered
     - `confirmed` - Customer confirmed order
     - `canceled` - Customer canceled order
     - `expired` - No response within timeout period
     - `failed` - Technical failure in processing

3. **Customer Engagement**
   - Sends WhatsApp verification request with order details
   - Waits for customer interaction
   - Processes button clicks or text responses

4. **Platform Update**
   - Updates source platform with verification outcome
   - Applies tags for merchant workflow automation
   - Logs all actions for audit and analytics

#### Retry & Timeout Management

- Configurable retry attempts for failed messages
- Scheduled retry with exponential backoff
- Automatic expiration after defined period
- Next retry timestamp tracking

---

### 4. Data Management & Storage

#### PostgreSQL Database (Supabase)

- **Organizations Table**: Multi-tenant business accounts
  - Organization name and slug
  - Plan type (Free, Pro, Enterprise)
  - Subscription management fields
  - Row-level security policies

- **Memberships Table**: User access control
  - User-organization relationships
  - Role assignments (Owner, Admin, Viewer)
  - Invitation and permission management

- **Integrations Table**: Platform connections
  - Platform type (Shopify, Salla, Zid, WooCommerce)
  - Platform store URL and credentials
  - OAuth tokens with expiration tracking
  - Configuration and metadata storage

- **Orders Table**: Normalized order data
  - External order ID and order number
  - Customer information (name, phone)
  - Order totals and currency
  - Raw platform payload for reference
  - Links to parent organization and integration

- **Verifications Table**: Verification workflow state
  - Status and lifecycle tracking
  - WhatsApp message ID linkage
  - Retry scheduling and attempt counting
  - Response timestamps and outcomes

#### Security Features

- Row-Level Security (RLS) policies
- Multi-tenant data isolation
- Encrypted OAuth tokens
- Audit trail maintenance

---

### 5. Integration Hub Architecture

#### Spoke Pattern Design

The platform uses a **Hub-and-Spoke** architecture where:

- **Core Hub (Verification Hub Service)**:
  - Orchestrates all verification workflows
  - Platform-agnostic business logic
  - Coordinates between spokes (integrations)

- **Spokes (Platform Adapters)**:
  - **Meta Spoke**: WhatsApp Cloud API integration
  - **Shopify Spoke**: Shopify-specific authentication and API calls
  - **WooCommerce Spoke**: (Future) WooCommerce integration

#### Benefits

- Easily add new platforms without changing core logic
- Standardized order normalization across platforms
- Centralized verification management
- Scalable architecture for growth

---

### 6. Webhook Management

#### Incoming Webhooks

- **Shopify Webhooks**:
  - `orders/create` - New order events
  - `app/uninstalled` - App removal events
  - Registration characteristics:
    - Idempotent and safe to re-run (HTTP 422 treated as success)
    - Uses configured Admin API version with `X-Shopify-Access-Token`
    - Runs non-blocking during OAuth callback; failures logged and retried with backoff
  - HMAC signature validation for security
- **WhatsApp Webhooks**:
  - Message delivery status updates
  - Customer button click events
  - Message read receipts
  - Webhook verification for Meta compliance

#### Webhook Security

- HMAC-SHA256 signature validation
- Verify token authentication
- IP whitelisting capability
- Rate limiting and DDoS protection

---

### 7. API Capabilities

#### Shopify GraphQL Admin API

- **Order Tagging**: Adds verification status tags to orders
- **Order Queries**: Fetches order details when needed
- **OAuth Flow**: Manages app installation and permissions
- **Webhook Registration**: Programmatic webhook setup

#### WhatsApp Business API

- **Template Messaging**: Sends pre-approved message templates
- **Message Status**: Tracks delivery and read receipts
- **Interactive Components**: Button and list message support
- **Media Support**: Ready for future image/document sharing

---

## Technical Capabilities

### 1. Built on NestJS Framework

- **Modular Architecture**: Clean separation of concerns
- **Dependency Injection**: Testable and maintainable code
- **TypeScript**: Type-safe development
- **Middleware & Guards**: Request validation and security

### 2. Database ORM (Drizzle)

- **Type-Safe Queries**: Compile-time SQL validation
- **Migration Management**: Version-controlled schema changes
- **Relation Handling**: Automatic joins and eager loading
- **Connection Pooling**: Optimized database performance

### 3. Configuration Management

- **Environment-Based Config**: Separate configs for dev/prod
- **Secrets Management**: Secure credential storage
- **Global Config Module**: Centralized configuration access

### 4. Logging & Monitoring

- **Structured Logging**: JSON-formatted logs for analysis
- **Context-Based Logging**: Request tracing and debugging
- **Error Tracking**: Exception handling and reporting
- **Audit Trails**: Complete action history per order

---

## Business Use Cases

### Use Case 1: Reducing Failed Deliveries

**Scenario**: A Shopify store receives 100 COD orders daily, with 30% fake or incorrect numbers.

**Akeed Solution**:

1. Automatically sends WhatsApp verification to all 100 orders
2. Customers with wrong numbers can't respond → Orders auto-canceled
3. Customers confirm valid orders → Tagged for fulfillment
4. Result: Ship only 70 verified orders, saving 30% on logistics costs

### Use Case 2: Customer Preference Changes

**Scenario**: Customer orders a product but changes their mind within minutes.

**Akeed Solution**:

1. Customer receives verification message immediately
2. Customer clicks "Cancel Order" button
3. Order automatically tagged in Shopify as canceled
4. Merchant doesn't process/pack the order
5. Result: Saves fulfillment costs and inventory management effort

### Use Case 3: Phone Number Validation

**Scenario**: Orders coming with incomplete or incorrect phone numbers.

**Akeed Solution**:

1. Attempts to send WhatsApp verification
2. Message fails if number is invalid
3. Order marked as failed verification
4. Merchant can contact customer through alternative means before shipping
5. Result: Prevents shipping to unreachable customers

### Use Case 4: Multi-Store Management

**Scenario**: A business operates 5 different Shopify stores across regions.

**Akeed Solution**:

1. Single Akeed organization account
2. All 5 stores connected as separate integrations
3. Unified verification workflow across all stores
4. Centralized dashboard for all order verifications
5. Result: Consistent verification process, unified reporting

---

## Target Market

### Primary Markets

- **Middle East & North Africa (MENA)**: High COD usage, strong WhatsApp adoption
- **Southeast Asia**: Growing e-commerce, COD-dependent markets
- **South Asia**: Large COD markets with verification needs
- **Latin America**: Emerging e-commerce with WhatsApp penetration

### Target Customer Profiles

#### 1. Small to Medium E-Commerce Businesses (SMBs)

- **Annual Revenue**: $100K - $5M
- **Order Volume**: 100 - 10,000 orders/month
- **Pain Point**: High COD return rates eating into margins
- **Value**: Automated verification at scale without hiring staff

#### 2. Enterprise Multi-Store Operators

- **Annual Revenue**: $5M+
- **Order Volume**: 10,000+ orders/month
- **Pain Point**: Managing verification across multiple brands/stores
- **Value**: Centralized verification, white-label capabilities, API access

#### 3. 3PL & Fulfillment Centers

- **Business Model**: Fulfill orders for multiple merchants
- **Pain Point**: Need verification before accepting orders
- **Value**: Pre-verified orders reduce return handling costs

---

## Pricing Model (Suggested)

### Free Tier

- Up to 50 verifications/month
- 1 platform integration
- Basic WhatsApp templates
- Email support

### Pro Tier ($49/month)

- Up to 1,000 verifications/month
- Unlimited platform integrations
- Custom templates
- Priority support
- Analytics dashboard

### Enterprise Tier (Custom Pricing)

- Unlimited verifications
- White-label options
- Dedicated account manager
- API access
- Custom integrations
- SLA guarantees

---

## Competitive Advantages

1. **Multi-Platform Support**: Not locked to one e-commerce platform
2. **WhatsApp Native**: Uses the most popular messaging app in target markets
3. **Automated Bidirectional Updates**: Closes the loop with platform tagging
4. **Multi-Tenant Ready**: Scale from 1 to 10,000+ merchants
5. **Developer-Friendly**: Clean API, webhook support, extensible architecture
6. **Security First**: RLS policies, OAuth, HMAC validation built-in
7. **Hub-Spoke Architecture**: Easy to add new platforms and channels

---

## Roadmap & Future Capabilities

### Phase 1 (Current - MVP)

- ✅ Shopify integration
- ✅ WhatsApp message sending
- ✅ Button-based confirmations
- ✅ Order tagging in Shopify
- ✅ Multi-tenant architecture

### Phase 2 (In Progress)

- 🔄 WooCommerce integration
- 🔄 Dashboard analytics
- 🔄 Custom template builder
- 🔄 Retry scheduling improvements

### Phase 3 (Planned)

- 📅 Salla & Zid integrations (MENA platforms)
- 📅 SMS fallback for non-WhatsApp users
- 📅 Multiple verification attempts
- 📅 Customer preference memory (auto-confirm trusted customers)
- 📅 Fraud detection patterns

### Phase 4 (Future Vision)

- 📅 AI-powered response understanding (NLP for text responses)
- 📅 Voice call verification option
- 📅 Address verification with maps
- 📅 Payment link integration for converting COD to prepaid
- 📅 Branded merchant WhatsApp numbers
- 📅 Multi-language support with auto-detection
- 📅 Shopify app store listing
- 📅 White-label reseller program

---

## Technical Requirements for Deployment

### Infrastructure

- **Compute**: Node.js server (recommended: 1 vCPU, 2GB RAM minimum)
- **Database**: PostgreSQL 14+ (Supabase or self-hosted)
- **Storage**: Minimal (primarily database-backed)
- **Networking**: HTTPS endpoints for webhook reception

### External Services

- **Meta Business Account**: For WhatsApp Cloud API access
- **Meta Business Phone Number**: Verified business phone number
- **Shopify Partners Account**: For OAuth app credentials
- **Domain/Hosting**: Public URL for webhook endpoints

### Environment Variables

```
NODE_ENV=production
PORT=3000
APP_URL=https://yourdomain.com
DATABASE_URL=postgresql://...

# Meta WhatsApp
WA_PHONE_NUMBER_ID=...
WA_BUSINESS_ACCOUNT_ID=...
WA_ACCESS_TOKEN=...
WA_VERIFY_TOKEN=...

# Shopify
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SHOPIFY_SCOPES=read_orders,write_orders
SHOPIFY_REDIRECT_URI=https://yourdomain.com/auth/shopify/callback
SHOPIFY_API_VERSION=2026-01
```

---

## Success Metrics & KPIs

### For Merchants Using Akeed

- **Reduction in Failed Deliveries**: Target 40-60% reduction
- **Cost Savings**: Logistics and return handling costs reduced
- **Time Savings**: No manual verification calls needed
- **Verification Rate**: % of customers who respond to verification
- **Confirmation Rate**: % of verified orders that are confirmed

### For Akeed as a Platform

- **Monthly Active Merchants**: Number of paying organizations
- **Total Verifications Sent**: Volume metric
- **Platform Uptime**: 99.9% target
- **Webhook Processing Latency**: < 5 seconds target
- **Customer Response Time**: Average time to respond
- **Integration Success Rate**: % of successful platform connections

---

## Compliance & Data Privacy

### GDPR Compliance

- Customer data processed only for verification purpose
- Data retention policies configurable per merchant
- Right to deletion (GDPR Article 17)
- Data portability support

### WhatsApp Business Policy Compliance

- All templates submitted for Meta approval
- No promotional messaging (verification only)
- Opt-out mechanisms available
- 24-hour message window compliance

### Payment Card Industry (PCI)

- No card data stored or processed
- Order totals displayed but no payment details
- Compliant with PCI-DSS scope reduction

---

## Support & Documentation

### For Merchants

- **Getting Started Guide**: Platform connection walkthrough
- **WhatsApp Template Submission Guide**: Meta approval process
- **Troubleshooting FAQs**: Common issues and solutions
- **Video Tutorials**: Setup and configuration walkthroughs

### For Developers

- **API Documentation**: REST API reference
- **Webhook Specifications**: Payload formats and signatures
- **Database Schema**: Entity relationship diagrams
- **Architecture Overview**: Technical system design docs

---

## Conclusion

Akeed is a production-ready, scalable platform that solves a real business problem in markets where COD is prevalent. With its multi-tenant architecture, extensible integration framework, and robust verification workflow, Akeed is positioned to become the de facto standard for automated e-commerce order verification via WhatsApp.

The platform combines modern technical architecture (NestJS, TypeScript, PostgreSQL) with practical business capabilities (multi-platform integration, automated messaging, workflow orchestration) to deliver measurable ROI for merchants while maintaining the flexibility to expand into new markets, platforms, and communication channels.

---

**Document Version**: 1.0  
**Last Updated**: January 26, 2026  
**Maintained By**: Akeed Development Team
