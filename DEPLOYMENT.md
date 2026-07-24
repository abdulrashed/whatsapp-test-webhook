# GitHub and Vercel Deployment

This repository is prepared for GitHub import and Vercel deployment.

## Do Not Commit Secrets

Keep real values only in `.env` locally and in Vercel Environment Variables.

Required Vercel variables:

```env
GRAPH_API_VERSION=v25.0
WHATSAPP_TOKEN=your_generated_access_token
WHATSAPP_PHONE_NUMBER_ID=1107576985771392
WHATSAPP_WABA_ID=2850166098660100
WHATSAPP_VERIFY_TOKEN=your_private_verify_token
META_APP_SECRET=your_meta_app_secret
VALIDATE_META_SIGNATURE=true
```

## GitHub

The intended repository name is:

```text
whatsapp-test-webhook
```

After GitHub CLI authentication is fixed:

```powershell
gh auth login -h github.com
gh repo create whatsapp-test-webhook --private --source . --remote origin --push
```

## Vercel

1. Open Vercel dashboard.
2. Import the GitHub repository.
3. Framework preset: Other.
4. Build command: leave empty.
5. Output directory: leave empty.
6. Add the environment variables listed above.
7. Deploy.

After deployment, configure Meta:

```text
Callback URL: https://your-vercel-project.vercel.app/webhook
Verify token: same as WHATSAPP_VERIFY_TOKEN
Webhook field: messages
```

Test:

```text
https://your-vercel-project.vercel.app/health
```
