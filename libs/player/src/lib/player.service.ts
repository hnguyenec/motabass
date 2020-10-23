/// <reference types="wicg-mediasession" />

import { Injectable } from '@angular/core';
import { ThemeService } from '@motabass/core/theme';
import { LoaderService } from '@motabass/helper-services/loader';
import { WakelockService } from '@motabass/helper-services/wakelock';
import { action, observable } from 'mobx-angular';
import { LocalStorage, LocalStorageService } from 'ngx-webstorage';
import { FileLoaderService } from './file-loader-service/file-loader.service.abstract';
import { MetadataService } from './metadata-service/metadata.service';
import { BandFrequency, RepeatMode, Song, SongMetadata } from './player.types';

export const BAND_FREQUENIES: BandFrequency[] = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

@Injectable({ providedIn: 'any' })
export class PlayerService {
  bands: { [band: number]: BiquadFilterNode } = {};

  @LocalStorage('eqBandGains', { 60: 0, 170: 0, 310: 0, 600: 0, 1000: 0, 3000: 0, 6000: 0, 12000: 0, 14000: 0, 16000: 0 }) bandGains!: {
    [band: number]: number;
  };

  private audioCtx!: AudioContext;
  private gainNode!: GainNode;
  private analyserNode!: AnalyserNode;
  private audioSrcNode!: MediaElementAudioSourceNode;

  private loadFinished = true;

  @observable songs: Song[] = [];

  @observable playingSong?: Song;

  audioElement!: HTMLAudioElement;

  @observable selectedSong?: Song;

  @LocalStorage('repeat', 'off') repeat!: RepeatMode;

  @LocalStorage('shuffle', false) shuffle!: boolean;

  constructor(
    private fileLoaderService: FileLoaderService,
    private metadataService: MetadataService,
    private storageService: LocalStorageService,
    private themeService: ThemeService,
    private loaderService: LoaderService,
    private wakelockService: WakelockService
  ) {
    this.initAudioElement();
    this.initAudioContext();
    this.initEqualizer();

    this.audioSrcNode = this.audioCtx.createMediaElementSource(this.audioElement);

    const storedVolume = storageService.retrieve('volume');
    this.gainNode.gain.value = storedVolume ?? 0.5;

    if (navigator.mediaSession) {
      navigator.mediaSession.setActionHandler('play', () => this.playPause());
      navigator.mediaSession.setActionHandler('pause', () => this.playPause());
      navigator.mediaSession.setActionHandler('stop', () => this.stop());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('seekbackward', () => this.seekLeft(10));
      navigator.mediaSession.setActionHandler('seekforward', () => this.seekRight(10));
    }
    BAND_FREQUENIES.forEach((bandFrequency) => {
      const filter = this.bands[bandFrequency];
      filter.gain.value = this.bandGains[bandFrequency];
    });
  }

  initAudioElement() {
    const audio = new Audio();
    audio.loop = false;
    audio.id = 'main_audio';
    audio.style.display = 'none';
    audio.autoplay = false;
    audio.controls = false;
    audio.volume = 0.8;
    audio.preload = 'metadata';
    audio.onended = () => {
      console.log('ended');
      this.next();
    };
    audio.onerror = (e) => {
      console.error(e);
    };
    this.audioElement = audio;

    document.body.appendChild(audio);
  }

  initAudioContext() {
    const audioCtx = new AudioContext({
      latencyHint: 'playback',
      sampleRate: 48000
    });

    const analyser = audioCtx.createAnalyser();
    const gainNode = audioCtx.createGain();

    analyser.connect(gainNode);

    gainNode.connect(audioCtx.destination);

    this.audioCtx = audioCtx;
    this.analyserNode = analyser;
    this.gainNode = gainNode;
  }

  initEqualizer() {
    let output: AudioNode = this.analyserNode;

    BAND_FREQUENIES.forEach((bandFrequency, i) => {
      const filter = this.audioCtx.createBiquadFilter();

      this.bands[bandFrequency] = filter;

      if (i === 0) {
        // The first filter, includes all lower frequencies
        filter.type = 'lowshelf';
      } else if (i === BAND_FREQUENIES.length - 1) {
        // The last filter, includes all higher frequencies
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1;
      }
      filter.frequency.value = bandFrequency;

      output.connect(filter);
      output = filter;
    });

    output.connect(this.gainNode);
  }

  @action async setPlayingSong(song: Song | undefined) {
    if (!song) {
      return;
    }
    const oldSrc = this.audioElement.src;

    this.audioElement.src = URL.createObjectURL(song.file);

    URL.revokeObjectURL(oldSrc);

    this.playingSong = song;

    if (song.metadata) {
      this.setBrowserMetadata(song.metadata);

      if (this.themeService.coverArtColors) {
        const primaryColor = song.metadata.coverColors?.darkVibrant?.hex;
        this.themeService.setPrimaryColor(primaryColor);

        const accentColor = song.metadata.coverColors?.lightVibrant?.hex;
        this.themeService.setAccentColor(accentColor);
      }
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.audioSrcNode.connect(this.analyserNode);

    this.selectedSong = song;
    return this.wakelockService.activateWakelock();
  }

  @action async loadFiles(): Promise<void> {
    const files: File[] = await this.fileLoaderService.openFiles();
    return this.addFilesToPlaylist(files);
  }

  @action async addFilesToPlaylist(files: File[]) {
    if (files?.length) {
      for (const file of files) {
        this.loaderService.show();
        const song = await this.createSongFromFile(file);
        this.loaderService.hide();
        this.songs.push(song);
      }
    }
  }

  private async createSongFromFile(file: File): Promise<Song> {
    const song: Song = {
      file: file
    };
    song.metadata = await this.metadataService.getMetadata(file);
    return song;
  }

  getBandGain(bandFrequency: BandFrequency): number {
    return this.bandGains[bandFrequency];
  }

  @action setBandGain(bandFrequency: BandFrequency, gainValue: number) {
    this.bands[bandFrequency].gain.value = gainValue;

    const bandGains = this.bandGains;
    bandGains[bandFrequency] = gainValue;
    this.bandGains = bandGains;
  }

  @action setVolume(value: number) {
    if (value >= 0 && value <= 1) {
      this.storageService.store('volume', value);
      this.gainNode.gain.value = value;
    }
  }

  get volume() {
    return this.gainNode.gain.value;
  }

  get analyser(): AnalyserNode {
    return this.analyserNode;
  }

  @action setSeekPosition(value: number) {
    if (value !== null && value !== undefined && value >= 0 && value <= this.durationSeconds) {
      this.audioElement.currentTime = value;
      this.updateBrowserPositionState();
    }
  }

  get durationSeconds(): number {
    return this.playingSong ? Math.round(this.audioElement.duration) : 0;
  }

  getCurrentTime(): number {
    if (!this.playingSong) {
      return 0;
    }
    const pos = this.audioElement.currentTime;
    if (pos !== null && pos !== undefined) {
      return Math.floor(pos);
    } else {
      return 0;
    }
  }

  @action selectSong(song: Song) {
    this.selectedSong = song;
  }

  @action playPauseSong(song: Song) {
    if (!this.loadFinished) {
      return;
    }

    if (this.playingSong && song === this.playingSong) {
      this.playPause();
      return;
    }

    this.stop();

    this.setPlayingSong(song);

    this.loadFinished = false;
    this.audioElement.play().then(() => this.afterPlayLoaded());
  }

  afterPlayLoaded() {
    this.loadFinished = true;
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = 'playing';
    }
    this.updateBrowserPositionState();
  }

  @action playPause() {
    if (!this.playingSong || !this.loadFinished) {
      if (this.selectedSong) {
        this.setPlayingSong(this.selectedSong);
        this.loadFinished = false;
        this.audioElement.play().then(() => this.afterPlayLoaded());
      }
      return;
    }
    if (this.audioElement.paused) {
      this.loadFinished = false;
      this.audioElement.play().then(() => this.afterPlayLoaded());
    } else {
      this.audioElement.pause();
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }
  }

  @action stop() {
    if (!this.playingSong || !this.loadFinished) {
      return;
    }
    if (this.playing) {
      this.audioElement.pause();
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'paused';
      }
      this.audioElement.currentTime = 0;
    } else {
      this.audioElement.currentTime = 0;
    }

    this.wakelockService.releaseWakelock();
  }

  @action async next(): Promise<void> {
    if (!this.playingSong || !this.loadFinished) {
      return;
    }

    if (this.shuffle) {
      const randomPosition = getRandomInt(0, this.songs.length - 1);
      return this.playPauseSong(this.songs[randomPosition]);
    }

    const currPo = this.playingSong.playlistPosition;
    if (!currPo) {
      return;
    }

    if (currPo < this.songs.length) {
      return this.playPauseSong(this.songs[currPo]);
    } else if (this.repeat === 'all') {
      return this.playPauseSong(this.songs[0]);
    }
  }

  @action async previous() {
    if (!this.playingSong || !this.loadFinished) {
      return;
    }
    const currPo = this.playingSong.playlistPosition;
    if (!currPo) {
      return;
    }
    if (currPo > 1) {
      return this.playPauseSong(this.songs[currPo - 2]);
    }
  }

  @action selectNext() {
    if (!this.selectedSong) {
      return;
    }
    const currPo = this.selectedSong.playlistPosition;
    if (!currPo) {
      return;
    }

    if (currPo < this.songs.length) {
      this.selectedSong = this.songs[currPo];
    }
  }

  @action selectPrevious() {
    if (!this.selectedSong) {
      return;
    }
    const currPo = this.selectedSong.playlistPosition;
    if (!currPo) {
      return;
    }

    if (currPo > 1) {
      this.selectedSong = this.songs[currPo - 2];
    }
  }

  seekLeft(seconds: number) {
    this.setSeekPosition(this.getCurrentTime() - seconds);
  }

  seekRight(seconds: number) {
    this.setSeekPosition(this.getCurrentTime() + seconds);
  }

  get playing(): boolean {
    return !!this.playingSong && !this.audioElement.paused;
  }

  @action toggleRepeat() {
    switch (this.repeat) {
      case 'off':
        this.repeat = 'all';
        break;
      case 'all':
        this.audioElement.loop = true;
        this.repeat = 'one';
        break;
      case 'one':
        this.audioElement.loop = false;
        this.repeat = 'off';
        break;
    }
  }

  @action toggleShuffle() {
    this.shuffle = !this.shuffle;
  }

  updateBrowserPositionState() {
    if (navigator.mediaSession && navigator.mediaSession.setPositionState) {
      navigator.mediaSession.setPositionState({
        duration: this.audioElement.duration,
        playbackRate: this.audioElement.playbackRate,
        position: this.audioElement.currentTime
      });
    }
  }

  setBrowserMetadata(metadata: SongMetadata) {
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        artwork: metadata.coverUrl?.original ? [{ src: metadata.coverUrl?.original, sizes: '512x512' }] : undefined
      });
    }
  }
}

function getRandomInt(min: number, max: number) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
