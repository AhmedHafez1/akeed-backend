import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { TemplateLifecycleAction } from '../../shared/messaging/template-lifecycle.policy';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminTemplateDraftService } from './admin-template-draft.service';
import { AdminTemplateLifecycleService } from './admin-template-lifecycle.service';
import type { RequestWithAdmin } from './admin.types';
import {
  AdminTemplateDraftDto,
  AdminTemplateDraftUpdateDto,
  AdminTemplateDraftValidateDto,
  AdminTemplateReplacementDto,
  AdminTemplateTextDto,
} from './dto/admin-template-authoring.dto';
import { readRequestId } from './standalone-billing-operator.guard';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };
/** Each submit, check and edit is a call to the provider. */
const PROVIDER_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

/**
 * Staff template writes (US-08-06): drafts, submission, edits and the
 * activate, deactivate, set-default and retire actions. Every route sits
 * behind `AdminAccessGuard`, and every route that changes anything also needs
 * a named template operator. Nothing here deletes a template at the provider.
 *
 * This controller is registered before `AdminTemplatesController`, so the
 * literal `drafts` routes are matched before its `:key` routes.
 */
@Controller('api/admin/templates')
@UseGuards(AdminAccessGuard)
export class AdminTemplateAuthoringController {
  constructor(
    private readonly drafts: AdminTemplateDraftService,
    private readonly lifecycle: AdminTemplateLifecycleService,
  ) {}

  @Get('drafts')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  listDrafts(@Req() request: RequestWithAdmin) {
    return this.drafts.list(request.admin.userId);
  }

  @Post('drafts/validate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  validateDraft(@Body() body: AdminTemplateDraftValidateDto) {
    return this.drafts.check(body);
  }

  @Post('drafts')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  createDraft(
    @Req() request: RequestWithAdmin,
    @Body() body: AdminTemplateDraftDto,
  ) {
    return this.drafts.create(
      request.admin.userId,
      body,
      readRequestId(request),
    );
  }

  @Get('drafts/:id')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getDraft(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.drafts.get(request.admin.userId, id);
  }

  @Patch('drafts/:id')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  updateDraft(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AdminTemplateDraftUpdateDto,
  ) {
    return this.drafts.update(
      request.admin.userId,
      id,
      body,
      readRequestId(request),
    );
  }

  @Delete('drafts/:id')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  discardDraft(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.drafts.discard(
      request.admin.userId,
      id,
      readRequestId(request),
    );
  }

  @Post('drafts/:id/submit')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(PROVIDER_THROTTLE)
  submitDraft(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.drafts.submit(request.admin.userId, id, readRequestId(request));
  }

  @Post('drafts/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(PROVIDER_THROTTLE)
  reconcileDraft(
    @Req() request: RequestWithAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.drafts.reconcile(
      request.admin.userId,
      id,
      readRequestId(request),
    );
  }

  @Get(':key/impact')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  impact(@Param('key') key: string) {
    return this.lifecycle.impact(key);
  }

  @Post(':key/edit')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(PROVIDER_THROTTLE)
  edit(
    @Req() request: RequestWithAdmin,
    @Param('key') key: string,
    @Body() body: AdminTemplateTextDto,
  ) {
    return this.lifecycle.edit({
      userId: request.admin.userId,
      key,
      dto: body,
      requestId: readRequestId(request),
    });
  }

  @Post(':key/activate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  activate(@Req() request: RequestWithAdmin, @Param('key') key: string) {
    return this.act(request, key, 'activate');
  }

  @Post(':key/deactivate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  deactivate(
    @Req() request: RequestWithAdmin,
    @Param('key') key: string,
    @Body() body: AdminTemplateReplacementDto,
  ) {
    return this.act(request, key, 'deactivate', body.replacement_key);
  }

  @Post(':key/set-default')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  setDefault(@Req() request: RequestWithAdmin, @Param('key') key: string) {
    return this.act(request, key, 'set_default');
  }

  @Post(':key/retire')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(WhatsappTemplateOperatorGuard)
  @Throttle(WRITE_THROTTLE)
  retire(
    @Req() request: RequestWithAdmin,
    @Param('key') key: string,
    @Body() body: AdminTemplateReplacementDto,
  ) {
    return this.act(request, key, 'retire', body.replacement_key);
  }

  private act(
    request: RequestWithAdmin,
    key: string,
    action: TemplateLifecycleAction,
    replacementKey?: string,
  ) {
    return this.lifecycle.act({
      userId: request.admin.userId,
      key,
      action,
      replacementKey,
      requestId: readRequestId(request),
    });
  }
}
