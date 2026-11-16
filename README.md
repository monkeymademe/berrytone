# berrytone

Source: https://github.com/monkeymademe/berrytone

Berrytone is a home music player for files you already own. It runs in one Docker container and is meant to be opened from any phone or computer on the same network, at `http://<host>:8083`.

The container does not register a hostname. Use the machine’s address, or its existing mDNS name such as `http://<hostname>.local:8083`. Docker publishes the player on port 8083 of that machine.

## Run it

On the machine that will host the player:

```bash
cp .env.example .env
```

Set `MUSIC_PATH` and `DOWNLOADS_PATH` in `.env` to folders on that machine, then build and start:

```bash
docker compose up -d --build
```

Open `http://<host>:8083`. The first scan reads tags in the background. Press **Rescan** after you add more music.

To come back after a reboot, the Docker service needs to be enabled once:

```bash
sudo systemctl enable --now docker
```

The compose file uses `restart: unless-stopped`, so the player starts with the machine after that.

## Update it

On the machine running the player:

```bash
docker compose up -d --build
```

From another computer, set the login and folder, then send the code and rebuild:

```bash
export BERRYTONE_SSH=user@music-host
export BERRYTONE_DEST=berrytone
npm run update
```

That copies this folder to the host and runs `docker compose up -d --build` there. The music folder, the downloads folder, and the saved index are left in place.

The first time, allow this computer to log in. The host will ask for that account’s password once:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@music-host
```

### Where the music lives

`docker-compose.yml` mounts `MUSIC_PATH` at `/music` and `DOWNLOADS_PATH` at `/downloads`. The search index stays in a Docker volume named `berrytone-data`. Music in the downloads folder can be played from **Folders → download**. Those files are not scanned into the library, so they stay out of albums, artists, playlists, and Amperfy.

Useful values:

| Variable | Purpose |
| --- | --- |
| `BERRYTONE_PORT` | Port Berrytone listens on. Default is `8083`, so the player is at `http://<host>:8083`. The container uses the host network so it can see Sonos speakers. |
| `MUSIC_PATH` | Music folder on the host machine, mounted at `/music` in the container. |
| `DOWNLOADS_PATH` | Downloads folder on the host machine, mounted at `/downloads`. |
| `PUID` / `PGID` | User that can read the music. Check with `id -u` and `id -g` on the host. On a single-user Linux machine this is often `1000`. |
| `BERRYTONE_USER` / `BERRYTONE_PASSWORD` | First admin, created the first time the container starts with both values set. Leave both empty to keep the player open on your home network. |

Change `.env`, then run `docker compose up -d`.

### Playback

The browser plays the file directly. MP3, M4A, AAC, FLAC, Ogg, Opus, WAV, and AIFF are indexed. Phones are happiest with MP3 and M4A. Tags are used when they exist. Otherwise Berrytone reads `Artist/Album/Track` folders and the file name.

The speaker button in the player sends the current queue to a Sonos room on the same network. The speaker fetches each file from Berrytone, and the browser pauses so the song is not playing twice. MP3 and M4A are the reliable choices there. An admin can turn Sonos off for other people from **People**.

Restarting the container loads the saved library and does not contact MusicBrainz. **Rescan** reads the music folder for new or changed files. **Match albums** is the MusicBrainz pass: it fills in the expected track list for albums already in the library. Songs that live under another album stay where they are and are linked. Songs that are not in the library stay listed as missing. Nothing in the music folder is moved, copied, or retagged. Matching is slow, about one album a second, and the player stays usable while it runs.

Cover images named `cover`, `folder`, `front`, `album`, or `artwork` are picked up, and so is artwork embedded in the file.

On an album, a missing song can be added to **Find music**. Find searches YouTube and saves the pages so they can be opened later. Berrytone does not download the audio, and the music folder stays untouched.

### Amperfy

Berrytone speaks the Subsonic API, so the iPhone app Amperfy can browse, stream, and share playlists with the website.

In Amperfy, add a server:

- URL: `http://<host>:8083`
- Backend: Subsonic
- Username and password: an account from the People page. The first admin is the `BERRYTONE_USER` and `BERRYTONE_PASSWORD` from `.env`.

The website uses that same pair on its own sign-in page. If both are left blank and nobody has been added, the website stays open and Amperfy can use any username and password.

Admins open **People** to add accounts and to turn features on or off for everyone who is not an admin. A new person can browse and play every album. Artists, folders, tracks, favourites, playlists, Find music, downloads, rescan, and album matching stay off until an admin enables them. Admins keep every feature. Favourites and playlists are shared by the whole house.

Playlists and favourites saved on the website show up in Amperfy, and the ones saved in Amperfy show up on the website. A favourite is the same star Amperfy uses, for a song, an album, or an artist. Folders on the website follow the folders on disk, and Amperfy’s directory browser uses that same tree. Artists and albums stay grouped by their tags. Ratings and recently played albums are stored on the server too. The phone still handles its own equalizer, sleep timer, CarPlay, and offline cache. Podcasts, internet radio, ReplayGain, and transcoding are not part of this server, so FLAC and other formats the phone cannot play directly stay as the original file.

## Day to day

```bash
docker compose logs -f berrytone
docker compose restart
docker compose down
```

`down` stops the player and keeps the index volume. Your music folder is never modified.

## If it does not open

- **Port 8083 is taken.** Pick another `BERRYTONE_PORT` in `.env` and open `http://<host>` with that port.
- **The name does not resolve.** Use the machine’s IP address, from a device on the same network. A `.local` name works when mDNS is running on the host. On Linux that is Avahi, and `hostname` is the name you open.
- **The library stays empty.** Check `MUSIC_PATH`, and set `PUID` / `PGID` to a user who can read the files. Then use Rescan.
- **A song will not play.** That browser cannot decode the format. Keep an MP3 or M4A copy for phones.

## Without Docker

Node.js 22 or newer can run it directly:

```bash
npm install
MUSIC_DIR=./music DATA_DIR=./data PORT=8080 npm start
```

Then open http://localhost:8080.
