# Usenet Stats

Private Unraid dashboard for Radarr/Sonarr Usenet download statistics.

## Features

- Movies and TV episodes separated
- 7 / 30 / 90 day views without reloading Radarr/Sonarr on every switch
- Original release name
- Indexer used for the grab
- Grab time and import time
- Download client
- Unraid target folder and imported target file
- Quality, release group and size
- Read-only access to Radarr/Sonarr APIs

## Docker image

The `main` branch is built automatically with GitHub Actions and published to the private GitHub Container Registry package:

```text
ghcr.io/mlo-tek/usenet-stats:latest
```

Each build is also tagged with its Git commit SHA.

## Unraid

The included `unraid-template.xml` points to the GHCR image.

Required environment variables:

```text
RADARR_URL=http://10.20.20.9:7878
RADARR_API_KEY=...
SONARR_URL=http://10.20.20.10:8989
SONARR_API_KEY=...
USENET_CLIENT_NAMES=SABnzbd
PATH_MAPPINGS=/data/media=/mnt/user/data/media
CACHE_SECONDS=900
MAX_DAYS=90
TZ=Europe/Berlin
```

Because the GHCR package is private, the Unraid Docker daemon must be logged in to `ghcr.io` with the GitHub account that has package access.

After that, updates are handled through Unraid's normal **Check for Updates → Update** workflow.

## Image build

`.github/workflows/docker-publish.yml` builds `linux/amd64` and pushes `latest` after every push to `main`.
