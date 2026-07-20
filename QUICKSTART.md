# Quick Start Guide

## Installation & Setup (5 minutes)

### 1. Prerequisites
- Node.js v18+ ([download](https://nodejs.org/))
- npm (comes with Node.js)
- Git

### 2. Clone & Install
```bash
# Navigate to the project
cd /home/seraf/Documents/NOSTR

# Install dependencies
npm install
```

### 3. Start Development Server
```bash
npm run dev
```

The app opens at `http://localhost:5173`

## Your First NOSTR Session

### Step 1: Create Your Identity (Choose One Method)

**Option A: Login with Extension (Recommended)**
1. Install a NOSTR extension:
   - [Alby](https://getalby.com/)
   - [nos2x](https://nos2x.org/)
   - Other NIP-07 compatible extensions
2. Click **"🔗 Login with Extension"**
3. Approve the connection in your extension

**Option B: Generate New Key**
1. Click **"Generate New Key"**
2. Copy your private key and save it safely
3. Click **"Continue"**

**Option C: Import Existing Key**
1. Paste your private key (hex or nsec format)
2. Click **"Log In"** or use **"Paste from Clipboard"**

### Step 2: Set Up Your Profile
1. Click **"Profile"** in the top navigation
2. Click **"Edit Profile"**
3. Fill in your details:
   - **Name**: Your display name
   - **Bio**: About yourself
   - **Picture URL**: Link to your avatar image
   - **Website**: Your personal website
4. Click **"Save Changes"**

### Step 3: Write Your First Note
1. Go to **"Home"**
2. In the compose box at the top, write something
3. Add hashtags using the hashtag button
4. Click **"Publish"**
5. Your note appears in the global feed!

### Step 4: Browse & Interact
- **View Feed**: Scroll to see notes from the network
- **View Profiles**: Click on any username to see their profile
- **Add Reactions**: Click the ❤️ button and select an emoji
- **Reply**: Click 💬 to reply to notes
- **Search**: Click "Search" to find topics or users

## Common Tasks

### Import Existing Key
1. On the login screen, paste your private key
2. Click "Paste from Clipboard" or manually enter it
3. Click "Log In"

### Switch Between Pages
- **Home**: Main feed and compose
- **Profile**: Your profile and notes
- **Search**: Find notes and hashtags

### Edit Your Profile
1. Go to Profile page
2. Click "Edit Profile"
3. Make changes and save

### Find a Topic
1. Click "Search"
2. Choose "Search by hashtag"
3. Enter hashtag name (without #)
4. Browse results

## Features Overview

| Feature | Location | How to Use |
|---------|----------|-----------|
| **Compose Note** | Home page | Write and publish with hashtags |
| **View Profile** | Click any username | See user info and their notes |
| **Edit Profile** | Profile page | Update your information |
| **Search** | Navigation menu | Find notes and topics |
| **React to Notes** | ❤️ button on notes | Add emoji reactions |
| **Reply to Notes** | 💬 button on notes | Create conversations |
| **View Relay Status** | Top right corner | See if connected to network |

## Tips & Tricks

1. **Extension Login Benefits**
   - Your private key stays on your device
   - No need to copy/paste sensitive keys to websites
   - Extension handles all signing securely
   - Better security for long-term usage

2. **Your Private Key is Important**
   - If using manual login: store it safely (password manager)
   - Never share it with anyone
   - You can't recover a lost private key

3. **Hashtags Help**
   - Use them to organize topics (#bitcoin #nostr #privacy)
   - Search by hashtags to find related content
   - Popular hashtags help discoverability

4. **Multiple Relays**
   - The app connects to several relays by default
   - More relays = better connectivity
   - Relays are independent servers

5. **Privacy**
   - Only share what you're comfortable with
   - Use encryption for sensitive conversations
   - Your public key is permanent (it's your identity)

## Keyboard Shortcuts

- `Ctrl+Enter` or `Cmd+Enter` in compose box = Publish

## Troubleshooting

### "Cannot connect to relays"
- Check your internet connection
- Wait a few seconds and refresh
- Try again in a few moments

### "Event failed to publish"
- Verify you're logged in
- Check if relays are connected (top right indicator)
- Try again in a moment

### "Profile not loading"
- The user might have no profile set
- Try refreshing the page
- Wait for relays to respond

### Lost your private key?
- Generate a new one (click logout and create new)
- Your old identity will be gone
- Always back up your key!

## Next Steps

- Explore different relays by looking at settings
- Follow interesting users by searching for them
- Check out NOSTR apps at [nostrapps.com](https://nostrapps.com)
- Learn more about NOSTR at [nostr.how](https://nostr.how)

## Need Help?

- Check the [README.md](README.md) for detailed documentation
- Review the [NOSTR protocol](https://nostr.how/)
- Check browser console for error messages (F12 → Console)

---

**Happy NOSTRing! ⚡**
