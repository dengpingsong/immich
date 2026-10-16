import { Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetSubtitleGenerateResponseDto, AssetSubtitleResponseDto } from 'src/dtos/subtitle.dto';
import { ApiTag, Permission, RouteKey } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { TranscriptionService } from 'src/services/transcription.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class SubtitleController {
  constructor(private service: TranscriptionService) {}

  @Get(':id/subtitles')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve asset subtitles',
    description: 'Retrieve generated subtitle metadata for a video or the video part of a Live Photo.',
    history: new HistoryBuilder().added('v1').beta('v3.2.4'),
  })
  getSubtitle(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetSubtitleResponseDto> {
    return this.service.getSubtitle(auth, id);
  }

  @Get(':id/subtitles.vtt')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  @Endpoint({
    summary: 'Retrieve the WebVTT subtitle track',
    description: 'Retrieve the generated WebVTT track so a player can attach it to the video.',
    history: new HistoryBuilder().added('v1').beta('v3.2.4'),
  })
  getSubtitleTrack(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<string> {
    return this.service.getSubtitleTrack(auth, id);
  }

  @Post(':id/subtitles')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Generate subtitles for an asset',
    description: 'Queue subtitle generation for a video or the video part of a Live Photo.',
    history: new HistoryBuilder().added('v1').beta('v3.2.4'),
  })
  requestSubtitle(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<AssetSubtitleGenerateResponseDto> {
    return this.service.requestTranscription(auth, id);
  }

  @Delete(':id/subtitles')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete asset subtitles',
    description: 'Delete the generated subtitles of a video or the video part of a Live Photo.',
    history: new HistoryBuilder().added('v1').beta('v3.2.4'),
  })
  deleteSubtitle(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteSubtitle(auth, id);
  }
}
