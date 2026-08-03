# Publishing Guide: Play Store and Apple App Store

This app is currently a browser/static MVP. To publish it on Play Store and App Store, it must be packaged as a native mobile app.

Recommended path: use Capacitor to wrap the web app into Android and iOS apps.

## Phase 1: Finish App Requirements

1. Finalize the app name, icon, splash screen, and brand colors.
2. Replace the test `Plan` dropdown with real login/subscription status.
3. Add payment/subscription backend for Premium access.
4. Add privacy policy and terms pages.
5. Decide drawing processing method:
   - On-device processing, or
   - Server upload and processing.
6. Add PDF/DXF/DWG parser modules.
7. Test free vs premium restrictions.

## Phase 2: Prepare Mobile Build

1. Convert this static app into a buildable web project.
   - Recommended: Vite + React or plain Vite.
2. Add Capacitor.
3. Configure app ID:
   - Android package example: `com.yourcompany.qsspro`
   - iOS bundle ID example: `com.yourcompany.qsspro`
4. Generate Android project.
5. Generate iOS project.
6. Add app icons, splash screens, app permissions, and store metadata.

## Phase 3: Google Play Store

Official reference: Google Play Console Help says to create the app in Play Console, choose default language, app/game type, free/paid status, contact email, acknowledge policies/export laws, and accept Play App Signing terms.

1. Create a Google Play Developer account.
2. Open Play Console.
3. Click **Create app**.
4. Enter app name: `QSS Pro: Quantity Surveying Software`.
5. Select default language.
6. Select **App**, not Game.
7. Select free or paid. For this model, choose free app with in-app subscription.
8. Add support email.
9. Accept required declarations and Play App Signing terms.
10. Complete app dashboard tasks:
    - App access
    - Ads declaration
    - Content rating
    - Target audience
    - Data safety
    - Privacy policy
    - Store listing
11. Build signed Android App Bundle `.aab`.
12. Upload `.aab` to internal testing first.
13. Test on real Android devices.
14. Move to closed/open testing if required.
15. Submit production release for review.

Important Google notes:

- Google Play uses Android App Bundles for optimized delivery.
- Package names are permanent and cannot be reused.
- New personal developer accounts may need to meet testing requirements before production release.
- The app must meet current target API level requirements.

## Phase 4: Apple App Store

Official reference: Apple says to create an app record in App Store Connect before uploading a build. The record needs platform, app name, primary language, bundle ID, SKU, and user access settings.

1. Enroll in the Apple Developer Program.
2. Create an App ID / Bundle ID, for example `com.yourcompany.qsspro`.
3. Open App Store Connect.
4. Go to **Apps**.
5. Click **+** and select **New App**.
6. Select platform: iOS.
7. Enter app name: `QSS Pro: Quantity Surveying Software`.
8. Select primary language.
9. Select the bundle ID.
10. Enter SKU, for example `QSSPRO-IOS-001`.
11. Create the app record.
12. Open the generated iOS project in Xcode.
13. Configure signing and capabilities.
14. Archive the app in Xcode.
15. Upload build to App Store Connect.
16. Add app information:
    - Description
    - Keywords
    - Screenshots
    - Support URL
    - Marketing URL, optional
    - Privacy policy URL
17. Configure subscriptions/in-app purchases for Premium.
18. Add App Review notes explaining login and test account access.
19. Submit for App Review.

Important Apple notes:

- The Account Holder must accept the latest agreements before app creation.
- App Review may not process submissions in the exact order submitted.
- Provide clear review notes if features require login, payment, or uploaded drawings.

## Phase 5: Store Assets Checklist

- App icon
- Splash screen
- 5 to 8 screenshots per platform
- App preview video, optional
- Short description
- Full description
- Keywords
- Privacy policy URL
- Support email
- Support website
- Terms of service URL
- Test login for reviewers
- Demo drawing files for review

## Recommended First Technical Milestone

Build Android first because Play Store testing is usually easier to iterate:

1. Convert app to Vite.
2. Add Capacitor Android.
3. Build `.aab`.
4. Test on Android phone.
5. Then add iOS/Xcode build.
