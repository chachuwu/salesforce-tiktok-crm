# Salesforce CDC Setup Guide

## 1. Enable Change Data Capture for Lead object

1. Go to **Setup → Integrations → Change Data Capture**
2. Under "Available Entities", select **Lead**
3. Move it to **Selected Entities**
4. Click **Save**

## 2. Create a Connected App (OAuth2)

1. Go to **Setup → Apps → App Manager → New Connected App**
2. Enable **OAuth Settings**:
   - Callback URL: `https://your-service.com/oauth/callback`
   - Selected OAuth Scopes:
     - `api`
     - `refresh_token, offline_access`
     - `cdp_ingest_api` (for CDC)
3. Enable **Require Secret for Web Server Flow**
4. Save and copy `Client ID` and `Client Secret` to `.env`

## 3. Add Custom Fields to Lead Object

Create these custom fields on the **Lead** object:

| Field Label    | API Name        | Type       | Purpose                    |
|----------------|-----------------|------------|----------------------------|
| TikTok Click ID| TTCLID__c       | Text(255)  | Capture ttclid from URL    |
| External ID    | External_Id__c  | Text(255)  | Cross-device user identifier|
| IP Address     | IP_Address__c   | Text(45)   | Captured from landing page |
| User Agent     | User_Agent__c   | Text(1024) | Captured from landing page |

**To create:**
- Setup → Object Manager → Lead → Fields & Relationships → New

## 4. Web-to-Lead TTCLID Capture

Add to your landing page form handler:

```javascript
// Capture TikTok click ID from URL params
const urlParams = new URLSearchParams(window.location.search);
const ttclid = urlParams.get('ttclid') ?? '';

// Include in Web-to-Lead form as hidden field
document.getElementById('TTCLID__c').value = ttclid;
document.getElementById('IP_Address__c').value = await fetch('/api/ip').then(r => r.text());
document.getElementById('User_Agent__c').value = navigator.userAgent;
```

## 5. TikTok Pixel Integration (for TTCLID population)

Add to your TikTok Pixel base code:

```javascript
ttq.load('YOUR_PIXEL_ID');
ttq.page();
// ttclid is automatically appended to landing page URLs by TikTok Ads
// It will appear as ?ttclid=<value> in the URL
```

## 6. Verify CDC Events

Use the Salesforce Workbench to test:
1. Go to [workbench.developerforce.com](https://workbench.developerforce.com)
2. Utilities → Streaming Push Topics
3. Subscribe to: `/data/LeadChangeEvent`
4. Create/update a Lead and watch events appear
