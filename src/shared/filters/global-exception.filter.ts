import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { InvalidPhoneNumberError } from '../../core/errors/invalid-phone-number.error';

@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof InvalidPhoneNumberError) {
      const { httpAdapter } = this.adapterHost;
      const context = host.switchToHttp();

      httpAdapter.reply(
        context.getResponse(),
        {
          statusCode: 400,
          error: 'Bad Request',
          message: exception.message,
        },
        400,
      );
      return;
    }

    super.catch(exception, host);
  }
}
