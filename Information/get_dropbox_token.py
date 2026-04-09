import dropbox
from dropbox import DropboxOAuth2FlowNoRedirect

# Instructions:
# 1. Go to the Dropbox App Console: https://www.dropbox.com/developers/apps
# 2. Create a new app (Scoped access, App folder or Full Dropbox).
# 3. In the "Permissions" tab, check 'files.content.write' and 'files.content.read', then click Submit.
# 4. In the "Settings" tab, get your App Key and App Secret.
# 5. Fill them in below and run this script.

APP_KEY = input("Enter your Dropbox App Key: ").strip()
APP_SECRET = input("Enter your Dropbox App Secret: ").strip()

auth_flow = DropboxOAuth2FlowNoRedirect(APP_KEY, APP_SECRET, token_access_type='offline')

authorize_url = auth_flow.start()
print(f"\n1. Go to: {authorize_url}")
print("2. Click 'Allow' (you might have to log in first).")
print("3. Copy the authorization code.")

auth_code = input("\nEnter the authorization code here: ").strip()

try:
    oauth_result = auth_flow.finish(auth_code)
    print("\n--- SUCCESS ---")
    print(f"Refresh Token: {oauth_result.refresh_token}")
    print("\nAdd this token, your App Key, and App Secret to your config.json:")
    print('  "dropbox": {')
    print('    "enabled": true,')
    print(f'    "app_key": "{APP_KEY}",')
    print(f'    "app_secret": "{APP_SECRET}",')
    print(f'    "refresh_token": "{oauth_result.refresh_token}",')
    print('    "remote_path": "/trades"')
    print('  }')
except Exception as e:
    print(f"\nError: {e}")
