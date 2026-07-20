# ⚡ NOSTR Web App

A comprehensive, feature-rich NOSTR web application built with TypeScript and React. This application provides a full-featured NOSTR client experience similar to Pimal.net, with support for multiple relays, user profiles, event publishing, and more.

## Features

### 🔐 Authentication & Key Management
- Generate new cryptographic keys (secp256k1)
- Import existing private keys (hex or nsec format)
- **Login via NIP-07 extension** (Alby, nos2x, etc.)
- Secure key storage in localStorage
- Support for NIP-05 verification
- Automatic key binding to public key
- Extension-based signing support

### 📝 Publishing & Notes
- Compose and publish text notes (kind 1)
- Add hashtags to notes
- Reply to notes with proper threading
- Repost events
- Delete events
- Character count tracking
- Real-time publishing with feedback

### 👤 User Profiles
- View user profiles with complete metadata
- Update profile information
- Edit name, bio, profile picture, banner
- Support for NIP-05 identifiers
- Support for Lightning addresses (LUD-16)
- Website links and social info
- View user's notes/timeline
- Profile statistics

### 🌍 Feed Features
- **Global Feed**: Browse all notes from the network
- **Home Feed**: Personalized feed from follows (extensible)
- Real-time feed updates
- Refresh functionality
- Feed sorting by recency
- Hashtag browsing and filtering

### 🔍 Search Capabilities
- Full-text search across notes
- Search by content/keyword
- Search by hashtags (#tag)
- Advanced filtering options
- Search result aggregation from multiple relays

### ⚙️ Relay Management
- Connect to multiple NOSTR relays simultaneously
- Default relay list included (Damus, nos.lol, Nostr.band, etc.)
- Add/remove relays dynamically
- Relay connection status monitoring
- Read/write relay configuration
- Event deduplication across relays
- Robust error handling and reconnection

### 💬 Interactions
- React to notes with custom emojis
- Reply to notes with threading
- Like/favorite functionality (via reactions)
- Repost events
- Quote notes, long-form articles (`naddr`) and other events inline, rendered as an embedded quote card
- Link previews (Open Graph title/description/image) for plain URLs in note content
- View reply counts, repost counts, like counts and zap totals
- Event metadata caching

### 🔔 Notifications
- Unified feed of replies, mentions, reactions, reposts and zaps that reference you
- Unread badge in the header nav, backed by a persisted last-seen marker
- Live polling while the app is open

### ✉️ Private Direct Messages (NIP-17)
- End-to-end encrypted 1:1 messaging using NIP-44 encryption wrapped in NIP-59 gift wraps
- Relays never see who's messaging whom, or the message content — only the recipient (and the sender's own gift-wrapped copy) can decrypt
- Conversation list with unread tracking, per-thread view, works with both local-key and NIP-07 extension login (extension must support NIP-44)

### 🎨 User Interface
- Modern dark mode design
- Responsive layout (desktop, tablet, mobile)
- Smooth animations and transitions
- Intuitive navigation
- Clean component architecture
- Accessibility considerations

### 🔐 Cryptographic Security
- NIP-01 compliant event signing
- Event verification with public key cryptography
- NIP-44 (versioned) and legacy NIP-04 encryption primitives
- Secure credential handling
- No private key transmission

## Project Structure

```
nostr-web-app/
├── src/
│   ├── components/            # React components
│   │   ├── LoginPage.tsx      # Authentication UI
│   │   ├── HomePage.tsx       # Main feed page
│   │   ├── ProfilePage.tsx    # User profile display
│   │   ├── SearchPage.tsx     # Search functionality
│   │   ├── NotePage.tsx       # Single note + replies view
│   │   ├── NotificationsPage.tsx # Replies/mentions/reactions/reposts/zaps
│   │   ├── MessagesPage.tsx   # NIP-17 private DM conversations + threads
│   │   ├── SettingsPage.tsx   # Relay/app settings
│   │   ├── EventCard.tsx      # Individual note component
│   │   ├── QuotedNoteCard.tsx # Embedded quote card (note/nevent/naddr)
│   │   ├── LinkPreviewCard.tsx # Open Graph link preview card
│   │   ├── VideoPlayer.tsx    # Inline video embed
│   │   ├── ComposeNote.tsx    # Note composition form
│   │   └── EditProfileForm.tsx # Profile editing
│   ├── nostr/                 # NOSTR protocol implementation
│   │   ├── crypto.ts          # Keys, signing, NIP-04/NIP-44 encryption
│   │   ├── relay.ts           # Relay connection pooling
│   │   ├── core.ts            # Core protocol functions + caches
│   │   ├── notifications.ts   # Notification feed + unread tracking
│   │   └── dm.ts               # NIP-17 send/receive (seal + gift wrap)
│   ├── utils/
│   │   ├── helpers.ts         # Formatting utilities
│   │   ├── media.ts           # Image/video/YouTube/quote-ref extraction
│   │   └── linkPreview.ts     # Best-effort OG metadata fetch + cache
│   ├── types.ts               # TypeScript type definitions
│   ├── App.tsx                # Main app component
│   ├── main.tsx                # Entry point
│   └── index.css              # Global styling
├── index.html                 # HTML template
├── vite.config.ts             # Vite configuration
├── tsconfig.json               # TypeScript configuration
├── package.json               # Dependencies
└── README.md                  # This file
```

## Tech Stack

- **Frontend Framework**: React 18
- **Language**: TypeScript
- **Build Tool**: Vite
- **NOSTR Library**: nostr-tools
- **Styling**: CSS3 with CSS Variables
- **Key Management**: secp256k1 cryptography

## Installation

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Setup

1. Clone or download this repository
2. Navigate to the project directory:
```bash
cd nostr-web-app
```

3. Install dependencies:
```bash
npm install
```

4. Start the development server:
```bash
npm run dev
```

The app will open automatically at `http://localhost:5173`

## Usage

### Getting Started

1. **Create an Account**:
   - Click "Generate New Key" to create a new NOSTR identity
   - Save your private key securely
   - Or import an existing private key

2. **Set Up Your Profile**:
   - Go to "Profile" page
   - Click "Edit Profile"
   - Add your name, bio, picture, and other details
   - Save changes

3. **Browse the Feed**:
   - View global notes from the network
   - See recent activity and trending topics
   - Use hashtags to find specific topics

4. **Publish Notes**:
   - In the home feed, use the compose box
   - Write your note (max 300 characters)
   - Add hashtags using the hashtag button
   - Click "Publish" to share with the network

5. **Interact with Notes**:
   - React to notes with emojis
   - Reply to create conversations
   - Repost notes to share with followers
   - Search for specific content

6. **Find Users**:
   - Use search to find notes and topics
   - Click on usernames to view their profiles
   - See all their notes and information

## NOSTR Event Kinds Used

| Kind | Name | Usage |
|---|---|---|
| 0 | Metadata | Read/write user profiles |
| 1 | Text Note | Read/write notes, replies, quotes |
| 3 | Contacts | Read-only — powers the home feed; no follow/unfollow UI yet |
| 5 | Event Deletion | Delete your own events |
| 6 | Repost | Repost/quote-repost |
| 7 | Reaction | Emoji reactions |
| 13 | Seal | NIP-17 DM inner layer (sender-signed, NIP-44 encrypted) |
| 14 | Chat Message | NIP-17 DM plaintext rumor (never published directly) |
| 1059 | Gift Wrap | NIP-17 DM outer layer (published, ephemeral-key signed) |
| 9734 / 9735 | Zap Request / Receipt | Zap receipts are read and totalled; sending hands off to the recipient's Lightning wallet via a `lightning:` URI rather than constructing the request itself |
| 30023 | Long-form Content | Read-only, via `naddr` quote references |

## Supported NIPs

| NIP | Title | Notes |
|---|---|---|
| [01](https://github.com/nostr-protocol/nips/blob/master/01.md) | Basic protocol | Events, filters, relay `REQ`/`EVENT`/`EOSE` |
| [02](https://github.com/nostr-protocol/nips/blob/master/02.md) | Contact List | Read-only (home feed) |
| [04](https://github.com/nostr-protocol/nips/blob/master/04.md) | Encrypted DMs | Primitives implemented in `crypto.ts`; unused by the app — see NIP-17 |
| [05](https://github.com/nostr-protocol/nips/blob/master/05.md) | DNS Identifiers | Displayed on profiles; not cryptographically verified |
| [07](https://github.com/nostr-protocol/nips/blob/master/07.md) | Browser Extension | Login/sign/encrypt via `window.nostr` (Alby, nos2x, …) |
| [09](https://github.com/nostr-protocol/nips/blob/master/09.md) | Event Deletion | |
| [10](https://github.com/nostr-protocol/nips/blob/master/10.md) | Reply Threading | Basic `e` reply tag |
| [11](https://github.com/nostr-protocol/nips/blob/master/11.md) | Relay Information Document | Capability/paid-relay detection |
| [17](https://github.com/nostr-protocol/nips/blob/master/17.md) | Private Direct Messages | Full send/receive |
| [18](https://github.com/nostr-protocol/nips/blob/master/18.md) | Reposts | Repost and quote-repost |
| [19](https://github.com/nostr-protocol/nips/blob/master/19.md) | bech32 Entities | `npub`/`nsec`/`note`/`nevent`/`naddr`/`nprofile` |
| [21](https://github.com/nostr-protocol/nips/blob/master/21.md) | `nostr:` URI Scheme | |
| [25](https://github.com/nostr-protocol/nips/blob/master/25.md) | Reactions | |
| [27](https://github.com/nostr-protocol/nips/blob/master/27.md) | Text Note References | Inline `nostr:` mentions and quote cards |
| [44](https://github.com/nostr-protocol/nips/blob/master/44.md) | Encrypted Payloads (Versioned) | Used by NIP-17 |
| [57](https://github.com/nostr-protocol/nips/blob/master/57.md) | Zaps | Read/aggregate receipts only, see table above |
| [59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Gift Wrap | Used by NIP-17 |

Known gap: NIP-17 messages are published to your own configured relay pool rather than looking up the recipient's preferred DM relays (NIP-65/kind 10050), so delivery depends on sharing at least one relay with them.

## API Reference

### NostrCrypto
```typescript
// Generate new private key
const privkey = NostrCrypto.generatePrivateKey();

// Get public key from private key
const pubkey = NostrCrypto.getPublicKey(privkey);

// Sign an event
const signedEvent = NostrCrypto.signEvent(event, privkey);

// Verify event signature
const isValid = NostrCrypto.verifyEvent(signedEvent);

// Encode to bech32 formats
const npub = NostrCrypto.npubEncode(pubkey);
const nsec = NostrCrypto.nsecEncode(privkey);
```

### ExtensionManager (NIP-07)
```typescript
// Check if extension is available
const hasExt = ExtensionManager.hasExtension();

// Login via extension
const pubkey = await ExtensionManager.loginWithExtension();

// Get public key from extension
const pubkey = await ExtensionManager.getPublicKey();

// Sign event using extension
const signedEvent = await ExtensionManager.signEvent(event);

// Encrypt/decrypt message using extension (NIP-04)
const ciphertext = await ExtensionManager.encrypt(pubkey, plaintext);
const plaintext = await ExtensionManager.decrypt(pubkey, ciphertext);

// NIP-44 (required for NIP-17 direct messages)
const supportsNip44 = ExtensionManager.hasNip44();
const ciphertext44 = await ExtensionManager.encryptNip44(pubkey, plaintext);
const plaintext44 = await ExtensionManager.decryptNip44(pubkey, ciphertext);
```

### DirectMessageCore (NIP-17)
```typescript
// Send a private message (gift-wraps and publishes to both parties)
await DirectMessageCore.sendDirectMessage(recipientPubkey, content);

// Fetch and decrypt all messages addressed to you
const messages = await DirectMessageCore.fetchMessages(ownPubkey);

// Group into per-contact conversations, newest first
const conversations = DirectMessageCore.groupConversations(messages);
```

### NostrCore
```typescript
// Publish a note
const event = await NostrCore.publishNote(content, replyTo, hashtags);

// Publish profile
const event = await NostrCore.publishProfile(profile);

// Fetch user profile
const profile = await NostrCore.fetchUserProfile(pubkey);

// Fetch user notes
const notes = await NostrCore.fetchUserNotes(pubkey);

// Fetch home feed
const feed = await NostrCore.fetchHomeFeed(authors);

// Fetch global feed
const feed = await NostrCore.fetchGlobalFeed(limit);

// Search events
const results = await NostrCore.searchEvents(query);

// Add reaction
const reaction = await NostrCore.addReaction(eventId, emoji);
```

### RelayPool
```typescript
// Get relay pool instance
const relayPool = getRelayPool();

// Add relay
await relayPool.addRelay('wss://relay.damus.io');

// Remove relay
await relayPool.removeRelay('wss://relay.damus.io');

// Publish event
await relayPool.publishEvent(signedEvent);

// Subscribe to events
const subId = relayPool.subscribe(filters, callback, eoseCallback);

// Unsubscribe
relayPool.unsubscribe(subId);

// Fetch events
const events = await relayPool.fetchEvents(filters);
```

## Default Relays

The app connects to these relays by default:
- wss://relay.damus.io
- wss://nos.lol
- wss://nostr.mom
- wss://relay.nostr.net
- wss://purplepag.es (profile metadata)
- wss://nostr-pub.wellorder.net

You can add or remove relays from the relay management system.

## Build for Production

```bash
# Build the app
npm run build

# Preview production build
npm run preview

# Check for type errors
npm run type-check
```

The built app will be in the `dist` directory, ready for deployment.

## Deployment

The built app can be deployed to any static hosting service:
- Vercel
- Netlify
- GitHub Pages
- AWS S3 + CloudFront
- Any web server (Apache, nginx, etc.)

Just serve the `dist` folder as static files.

## Local Storage Data

The app stores the following in browser localStorage:
- `nostr_privkey` / `nostr_pubkey`: Your keypair (extension-mode logins only store the pubkey)
- `nostr_relay_configs` / `nostr_excluded_relays`: Relay pool configuration
- `nostr_notifications_seen_<pubkey>` / `nostr_dm_seen_<you>_<them>`: Read-state markers for the unread badges
- `nostr_recent_searches`: Recent search terms
- `nostr_cache_*`: Stale-while-revalidate cache for profiles, feeds, notes and DMs

⚠️ **Warning**: Private keys stored in localStorage are not highly secure. For production use, consider implementing additional security measures.

## Security Considerations

1. **Private Keys**: Never share your private key with anyone
2. **Storage**: localStorage is accessible to JavaScript and extensions
3. **HTTPS**: Always use HTTPS when accessing the app
4. **Verification**: Always verify event signatures
5. **Relay Trust**: Use trusted relays for sensitive data

## Contributing

Contributions are welcome! Areas for improvement:

- Follow/Unfollow functionality (kind 3 is currently read-only)
- Image upload support (hosting, not just linking)
- Advanced search filters
- Bookmarks
- NIP-57 zap request construction (currently hands off to the wallet via `lightning:`)
- NIP-47 Wallet Connect
- NIP-65/kind-10050 relay list lookup for DM delivery
- Push notifications
- User blocking/muting
- Emoji picker

## Roadmap

- [x] Direct messaging with encryption (NIP-17)
- [x] Notification system
- [x] Link previews
- [ ] Follow list management
- [ ] Bookmark functionality
- [ ] Image hosting integration
- [ ] Advanced filtering and sorting
- [ ] User blocking/muting
- [ ] Emoji picker
- [ ] Lightning zap request construction (NIP-57 send-side)
- [ ] Mobile app (React Native)

## Troubleshooting

### Cannot connect to relays
- Check internet connection
- Verify relay URLs are correct
- Try adding different relays
- Check browser console for errors

### Events not publishing
- Ensure private key is set
- Check relay connection status
- Verify event content is not empty
- Check browser security settings

### Profile not loading
- Ensure user's public key is correct
- Wait for relay response
- Try refreshing the page
- Check relay connection status

## References

- [NOSTR Protocol](https://nostr.how/)
- [NOSTR NIPs (Improvement Proposals)](https://github.com/nostr-protocol/nips)
- [nostr-tools Library](https://github.com/nbd-wtf/nostr-tools)
- [NIP-01: Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-19: bech32-encoded entities](https://github.com/nostr-protocol/nips/blob/master/19.md)

## License

MIT License - feel free to use this project for any purpose

## Support

For issues, questions, or suggestions:
1. Check the troubleshooting section
2. Review existing issues
3. Create a new issue with details about the problem
4. Include error messages from browser console

## Acknowledgments

Built with NOSTR protocol and open-source technologies. Thanks to the NOSTR community for creating this decentralized protocol!

---

**Made with ⚡ for the decentralized future**
