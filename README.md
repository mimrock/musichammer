# MusicHammer

Split songs into their parts — guitar, vocals, drums, bass and more — and practice along with any of them muted or soloed. Everything runs locally on your own machine: your audio never leaves your computer.

Installers for Windows (10/11) and Linux (AppImage / .deb) are on the [Releases](https://github.com/mimrock/musichammer/releases) page. On first launch the app asks before downloading its audio engine (about 1.5 GB, or 3.5 GB with an NVIDIA GPU); separation models (~0.7 GB each) are downloaded on demand from their authors' original repositories, with each model's license shown in the app.

The Windows installer is unsigned, so SmartScreen will warn you the first time — click "More info", then "Run anyway".

To build from source: `./setup.sh cpu` (or `cuda`) on Linux, then `./dev.sh`.

License: MIT.
