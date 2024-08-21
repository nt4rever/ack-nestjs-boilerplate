import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    ForbiddenException,
    HttpCode,
    HttpStatus,
    InternalServerErrorException,
    NotFoundException,
    Post,
    Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiKeyProtected } from 'src/modules/api-key/decorators/api-key.decorator';
import { ENUM_AUTH_LOGIN_FROM } from 'src/modules/auth/enums/auth.enum';
import { AuthJwtPayload } from 'src/modules/auth/decorators/auth.jwt.decorator';
import {
    AuthSocialAppleProtected,
    AuthSocialGoogleProtected,
} from 'src/modules/auth/decorators/auth.social.decorator';
import { AuthJwtAccessPayloadDto } from 'src/modules/auth/dtos/jwt/auth.jwt.access-payload.dto';
import { AuthJwtRefreshPayloadDto } from 'src/modules/auth/dtos/jwt/auth.jwt.refresh-payload.dto';
import { AuthSocialGooglePayloadDto } from 'src/modules/auth/dtos/social/auth.social.google-payload.dto';
import { AuthService } from 'src/modules/auth/services/auth.service';
import { Response } from 'src/common/response/decorators/response.decorator';
import { IResponse } from 'src/common/response/interfaces/response.interface';
import { ENUM_ROLE_STATUS_CODE_ERROR } from 'src/modules/role/enums/role.status-code.enum';
import { AuthLoginResponseDto } from 'src/modules/auth/dtos/response/auth.login.response.dto';
import {
    AuthPublicLoginCredentialDoc,
    AuthPublicLoginSocialAppleDoc,
    AuthPublicLoginSocialGoogleDoc,
    AuthPublicSignUpDoc,
} from 'src/modules/auth/docs/auth.public.doc';
import { AuthLoginRequestDto } from 'src/modules/auth/dtos/request/auth.login.request.dto';
import { UserService } from 'src/modules/user/services/user.service';
import { UserDoc } from 'src/modules/user/repository/entities/user.entity';
import { ENUM_USER_STATUS_CODE_ERROR } from 'src/modules/user/enums/user.status-code.enum';
import { ENUM_USER_STATUS } from 'src/modules/user/enums/user.enum';
import { IUserDoc } from 'src/modules/user/interfaces/user.interface';
import { AuthSocialApplePayloadDto } from 'src/modules/auth/dtos/social/auth.social.apple-payload.dto';
import { AuthSignUpRequestDto } from 'src/modules/auth/dtos/request/auth.sign-up.request.dto';
import { ENUM_COUNTRY_STATUS_CODE_ERROR } from 'src/modules/country/enums/country.status-code.enum';
import { ClientSession } from 'mongoose';
import { ENUM_EMAIL } from 'src/modules/email/enums/email.enum';
import { ENUM_APP_STATUS_CODE_ERROR } from 'src/app/enums/app.status-code.enum';
import { DatabaseConnection } from 'src/common/database/decorators/database.decorator';
import { ENUM_WORKER_QUEUES } from 'src/worker/enums/worker.enum';
import { WorkerQueue } from 'src/worker/decorators/worker.decorator';
import { Connection } from 'mongoose';
import { Queue } from 'bullmq';
import { CountryService } from 'src/modules/country/services/country.service';
import { RoleService } from 'src/modules/role/services/role.service';
import { PasswordHistoryService } from 'src/modules/password-history/services/password-history.service';
import { ENUM_PASSWORD_HISTORY_TYPE } from 'src/modules/password-history/enums/password-history.enum';
import { SessionService } from 'src/modules/session/services/session.service';
import { IRequestApp } from 'src/common/request/interfaces/request.interface';
import { ActivityService } from 'src/modules/activity/services/activity.service';
import { MessageService } from 'src/common/message/services/message.service';

@ApiTags('modules.public.auth')
@Controller({
    version: '1',
    path: '/auth',
})
export class AuthPublicController {
    constructor(
        @DatabaseConnection() private readonly databaseConnection: Connection,
        @WorkerQueue(ENUM_WORKER_QUEUES.EMAIL_QUEUE)
        private readonly emailQueue: Queue,
        private readonly userService: UserService,
        private readonly authService: AuthService,
        private readonly countryService: CountryService,
        private readonly roleService: RoleService,
        private readonly passwordHistoryService: PasswordHistoryService,
        private readonly sessionService: SessionService,
        private readonly activityService: ActivityService,
        private readonly messageService: MessageService
    ) {}

    @AuthPublicLoginCredentialDoc()
    @Response('auth.loginWithCredential')
    @ApiKeyProtected()
    @HttpCode(HttpStatus.OK)
    @Post('/login/credential')
    async loginWithCredential(
        @Body() { email, password }: AuthLoginRequestDto,
        @Req() request: IRequestApp
    ): Promise<IResponse<AuthLoginResponseDto>> {
        let user: UserDoc = await this.userService.findOneByEmail(email);
        if (!user) {
            throw new NotFoundException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.NOT_FOUND,
                message: 'user.error.notFound',
            });
        }

        const passwordAttempt: boolean =
            await this.authService.getPasswordAttempt();
        const passwordMaxAttempt: number =
            await this.authService.getPasswordMaxAttempt();
        if (passwordAttempt && user.passwordAttempt >= passwordMaxAttempt) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.PASSWORD_ATTEMPT_MAX,
                message: 'auth.error.passwordAttemptMax',
            });
        }

        const validate: boolean = await this.authService.validateUser(
            password,
            user.password
        );
        if (!validate) {
            user = await this.userService.increasePasswordAttempt(user);

            throw new BadRequestException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.PASSWORD_NOT_MATCH,
                message: 'auth.error.passwordNotMatch',
                data: {
                    attempt: user.passwordAttempt,
                },
            });
        } else if (user.status !== ENUM_USER_STATUS.ACTIVE) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'user.error.inactive',
            });
        }

        const userWithRole: IUserDoc = await this.userService.join(user);
        if (!userWithRole.role.isActive) {
            throw new ForbiddenException({
                statusCode: ENUM_ROLE_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'role.error.inactive',
            });
        }

        await this.userService.resetPasswordAttempt(user);

        const checkPasswordExpired: boolean =
            await this.authService.checkPasswordExpired(user.passwordExpired);
        if (checkPasswordExpired) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.PASSWORD_EXPIRED,
                message: 'auth.error.passwordExpired',
            });
        }

        const expiresInRefreshToken: number =
            await this.authService.getRefreshTokenExpirationTime();
        console.log('expiresInRefreshToken', expiresInRefreshToken);
        const session = await this.sessionService.create(request, {
            user: user._id,
        });
        await this.sessionService.setLoginSession(
            session._id,
            user._id,
            expiresInRefreshToken
        );

        const roleType = userWithRole.role.type;
        const tokenType: string = await this.authService.getTokenType();

        const expiresInAccessToken: number =
            await this.authService.getAccessTokenExpirationTime();
        const payloadAccessToken: AuthJwtAccessPayloadDto =
            await this.authService.createPayloadAccessToken(
                userWithRole,
                session._id,
                ENUM_AUTH_LOGIN_FROM.CREDENTIAL
            );
        const accessToken: string = await this.authService.createAccessToken(
            user.email,
            payloadAccessToken
        );

        const payloadRefreshToken: AuthJwtRefreshPayloadDto =
            await this.authService.createPayloadRefreshToken(
                payloadAccessToken
            );
        const refreshToken: string = await this.authService.createRefreshToken(
            user.email,
            payloadRefreshToken
        );

        return {
            data: {
                tokenType,
                roleType,
                expiresIn: expiresInAccessToken,
                accessToken,
                refreshToken,
            },
        };
    }

    @AuthPublicLoginSocialGoogleDoc()
    @Response('auth.loginWithSocialGoogle')
    @AuthSocialGoogleProtected()
    @Post('/login/social/google')
    async loginWithGoogle(
        @AuthJwtPayload<AuthSocialGooglePayloadDto>()
        { email }: AuthSocialGooglePayloadDto,
        @Req() request: IRequestApp
    ): Promise<IResponse<AuthLoginResponseDto>> {
        const user: UserDoc = await this.userService.findOneByEmail(email);
        if (!user) {
            throw new NotFoundException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.NOT_FOUND,
                message: 'user.error.notFound',
            });
        } else if (user.status !== ENUM_USER_STATUS.ACTIVE) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'user.error.inactive',
            });
        }

        const userWithRole: IUserDoc = await this.userService.join(user);
        if (!userWithRole.role.isActive) {
            throw new ForbiddenException({
                statusCode: ENUM_ROLE_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'role.error.inactive',
            });
        }

        await this.userService.resetPasswordAttempt(user);

        const checkPasswordExpired: boolean =
            await this.authService.checkPasswordExpired(user.passwordExpired);
        if (checkPasswordExpired) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.PASSWORD_EXPIRED,
                message: 'auth.error.passwordExpired',
            });
        }

        const expiresInRefreshToken: number =
            await this.authService.getRefreshTokenExpirationTime();

        const session = await this.sessionService.create(request, {
            user: user._id,
        });
        await this.sessionService.setLoginSession(
            session._id,
            user._id,
            expiresInRefreshToken
        );

        const roleType = userWithRole.role.type;
        const tokenType: string = await this.authService.getTokenType();

        const expiresInAccessToken: number =
            await this.authService.getAccessTokenExpirationTime();
        const payloadAccessToken: AuthJwtAccessPayloadDto =
            await this.authService.createPayloadAccessToken(
                userWithRole,
                session._id,
                ENUM_AUTH_LOGIN_FROM.SOCIAL_GOOGLE
            );
        const accessToken: string = await this.authService.createAccessToken(
            user.email,
            payloadAccessToken
        );

        const payloadRefreshToken: AuthJwtRefreshPayloadDto =
            await this.authService.createPayloadRefreshToken(
                payloadAccessToken
            );
        const refreshToken: string = await this.authService.createRefreshToken(
            user.email,
            payloadRefreshToken
        );

        return {
            data: {
                tokenType,
                roleType,
                expiresIn: expiresInAccessToken,
                accessToken,
                refreshToken,
            },
        };
    }

    @AuthPublicLoginSocialAppleDoc()
    @Response('user.loginWithSocialApple')
    @AuthSocialAppleProtected()
    @Post('/login/social/apple')
    async loginWithApple(
        @AuthJwtPayload<AuthSocialApplePayloadDto>()
        { email }: AuthSocialApplePayloadDto,
        @Req() request: IRequestApp
    ): Promise<IResponse<AuthLoginResponseDto>> {
        const user: UserDoc = await this.userService.findOneByEmail(email);
        if (!user) {
            throw new NotFoundException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.NOT_FOUND,
                message: 'user.error.notFound',
            });
        } else if (user.status !== ENUM_USER_STATUS.ACTIVE) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'user.error.inactive',
            });
        }

        const userWithRole: IUserDoc = await this.userService.join(user);
        if (!userWithRole.role.isActive) {
            throw new ForbiddenException({
                statusCode: ENUM_ROLE_STATUS_CODE_ERROR.INACTIVE_FORBIDDEN,
                message: 'role.error.inactive',
            });
        }

        await this.userService.resetPasswordAttempt(user);

        const checkPasswordExpired: boolean =
            await this.authService.checkPasswordExpired(user.passwordExpired);
        if (checkPasswordExpired) {
            throw new ForbiddenException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.PASSWORD_EXPIRED,
                message: 'auth.error.passwordExpired',
            });
        }

        const expiresInRefreshToken: number =
            await this.authService.getRefreshTokenExpirationTime();

        const session = await this.sessionService.create(request, {
            user: user._id,
        });
        await this.sessionService.setLoginSession(
            session._id,
            user._id,
            expiresInRefreshToken
        );

        const roleType = userWithRole.role.type;
        const tokenType: string = await this.authService.getTokenType();

        const expiresInAccessToken: number =
            await this.authService.getAccessTokenExpirationTime();
        const payloadAccessToken: AuthJwtAccessPayloadDto =
            await this.authService.createPayloadAccessToken(
                userWithRole,
                session._id,
                ENUM_AUTH_LOGIN_FROM.SOCIAL_GOOGLE
            );
        const accessToken: string = await this.authService.createAccessToken(
            user.email,
            payloadAccessToken
        );

        const payloadRefreshToken: AuthJwtRefreshPayloadDto =
            await this.authService.createPayloadRefreshToken(
                payloadAccessToken
            );
        const refreshToken: string = await this.authService.createRefreshToken(
            user.email,
            payloadRefreshToken
        );

        return {
            data: {
                tokenType,
                roleType,
                expiresIn: expiresInAccessToken,
                accessToken,
                refreshToken,
            },
        };
    }

    @AuthPublicSignUpDoc()
    @Response('auth.signUp')
    @ApiKeyProtected()
    @Post('/sign-up')
    async signUp(
        @Body()
        { email, name, password: passwordString, country }: AuthSignUpRequestDto
    ): Promise<void> {
        const promises: Promise<any>[] = [
            this.roleService.findOneByName('user'),
            this.userService.existByEmail(email),
            this.countryService.findOneActiveById(country),
        ];

        const [role, emailExist, checkCountry] = await Promise.all(promises);

        if (!role) {
            throw new NotFoundException({
                statusCode: ENUM_ROLE_STATUS_CODE_ERROR.NOT_FOUND,
                message: 'role.error.notFound',
            });
        } else if (!checkCountry) {
            throw new NotFoundException({
                statusCode: ENUM_COUNTRY_STATUS_CODE_ERROR.NOT_FOUND,
                message: 'country.error.notFound',
            });
        } else if (emailExist) {
            throw new ConflictException({
                statusCode: ENUM_USER_STATUS_CODE_ERROR.EMAIL_EXIST,
                message: 'user.error.emailExist',
            });
        }

        const password = await this.authService.createPassword(passwordString);

        const session: ClientSession =
            await this.databaseConnection.startSession();
        session.startTransaction();

        try {
            const user = await this.userService.signUp(
                role._id,
                {
                    email,
                    name,
                    password: passwordString,
                    country,
                },
                password,
                { session }
            );

            await this.passwordHistoryService.createByUser(
                user,
                {
                    type: ENUM_PASSWORD_HISTORY_TYPE.SIGN_UP,
                },
                { session }
            );

            await this.activityService.createByUser(
                user,
                {
                    description: this.messageService.setMessage(
                        'activity.user.signUp'
                    ),
                },
                { session }
            );

            this.emailQueue.add(
                ENUM_EMAIL.WELCOME,
                {
                    email,
                    name,
                },
                {
                    debounce: {
                        id: `${ENUM_EMAIL.WELCOME}-${user._id}`,
                        ttl: 1000,
                    },
                }
            );

            await session.commitTransaction();
            await session.endSession();
        } catch (err: any) {
            await session.abortTransaction();
            await session.endSession();

            throw new InternalServerErrorException({
                statusCode: ENUM_APP_STATUS_CODE_ERROR.UNKNOWN,
                message: 'http.serverError.internalServerError',
                _error: err.message,
            });
        }

        return;
    }
}
