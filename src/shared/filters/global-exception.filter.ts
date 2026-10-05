import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { InvalidPhoneNumberError } from '../errors/invalid-phone-number.error';
import { withoutQueryParameters } from '../logging/backend-log.util';

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

    // Nest logs the message and stack of an error nobody handled. A failed
    // query's message carries the statement's parameters, which are row
    // data, so it is handed on without them. The answer is the same 500.
    super.catch(
      exception instanceof Error
        ? withoutQueryParameters(exception)
        : exception,
      host,
    );
  }
}
