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
- View reply counts
- Event metadata caching

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
- NIP-04 message encryption support
- Secure credential handling
- No private key transmission

## Project Structure

```
nostr-web-app/
├── src/
│   ├── components/           # React components
│   │   ├── LoginPage.tsx     # Authentication UI
│   │   ├── HomePage.tsx      # Main feed page
│   │   ├── ProfilePage.tsx   # User profile display
│   │   ├── SearchPage.tsx    # Search functionality
│   │   ├── EventCard.tsx     # Individual note component
│   │   ├── ComposeNote.tsx   # Note composition form
│   │   └── EditProfileForm.tsx # Profile editing
│   ├── nostr/                # NOSTR protocol implementation
│   │   ├── crypto.ts         # Cryptographic operations
│   │   ├── relay.ts          # Relay connection pooling
│   │   └── core.ts           # Core NOSTR protocol functions
│   ├── utils/
│   │   └── helpers.ts        # Utility functions
│   ├── types.ts              # TypeScript type definitions
│   ├── App.tsx               # Main app component
│   ├── main.tsx              # Entry point
│   └── index.css             # Global styling
├── index.html                # HTML template
├── vite.config.ts            # Vite configuration
├── tsconfig.json             # TypeScript configuration
├── package.json              # Dependencies
└── README.md                 # This file
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

## NOSTR Event Types Supported

- **Kind 0**: User Metadata (profiles)
- **Kind 1**: Text Note (posts)
- **Kind 3**: Contacts (follow list)
- **Kind 5**: Event Deletion
- **Kind 6**: Repost
- **Kind 7**: Reaction (likes with custom emoji)
- **Kind 4**: Encrypted Direct Message (extensible)

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

// Encrypt message using extension
const ciphertext = await ExtensionManager.encrypt(pubkey, plaintext);

// Decrypt message using extension
const plaintext = await ExtensionManager.decrypt(pubkey, ciphertext);
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
- wss://relay.nostr.band
- wss://nostr.wine
- wss://relay.snort.social
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
- `nostr_privkey`: Encrypted private key
- `nostr_pubkey`: User's public key

⚠️ **Warning**: Private keys stored in localStorage are not highly secure. For production use, consider implementing additional security measures.

## Security Considerations

1. **Private Keys**: Never share your private key with anyone
2. **Storage**: localStorage is accessible to JavaScript and extensions
3. **HTTPS**: Always use HTTPS when accessing the app
4. **Verification**: Always verify event signatures
5. **Relay Trust**: Use trusted relays for sensitive data

## Contributing

Contributions are welcome! Areas for improvement:

- Direct messages (NIP-04)
- Follow/Unfollow functionality
- Notifications
- Image upload support
- Video embedding
- Advanced search filters
- Bookmarks
- Zaps (Lightning payments)
- NIP-47 Wallet Connect
- Push notifications

## Roadmap

- [ ] Direct messaging with encryption
- [ ] Follow list management
- [ ] Bookmark functionality
- [ ] Image hosting integration
- [ ] Video embedding support
- [ ] Advanced filtering and sorting
- [ ] Notification system
- [ ] User blocking/muting
- [ ] Emoji picker
- [ ] Link previews
- [ ] Lightning integration (Zaps)
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
