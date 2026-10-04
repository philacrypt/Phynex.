# Security/bug-fix changelog
See the chat summary. New env vars: MPESA_CALLBACK_SECRET, ADMIN_PASSWORD (already required), PHYNEX_DATA_DIR (uploads now live in $PHYNEX_DATA_DIR/uploads).
Node >= 22 is required (better-sqlite3 13.x). Run `npm install` to refresh package-lock.json (it was missing multer and google-auth-library).
