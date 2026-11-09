import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@clinic.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}

/** The answer to a correct password of an account with two-factor sign-in. */
export class MfaChallengeDto {
  @ApiProperty({ example: true })
  mfaRequired: true;

  @ApiProperty({ description: 'Valid five minutes, only for POST /auth/mfa/verify.' })
  mfaToken: string;
}

export class VerifyMfaLoginDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  mfaToken: string;

  @ApiPropertyOptional({ example: '123456', description: 'A code of the authenticator app.' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'k7qm-2xdp', description: 'Or one of the recovery codes.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

export class MfaPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/)
  code: string;
}

export class DisableMfaDto extends MfaCodeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'admin@clinic.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token received by email' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'NewSecurePassword123!' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}

export class ChangeOwnPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty()
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    tenantId: string;
    mustChangePassword: boolean;
    /** The account signs in with a second factor. */
    mfaEnabled?: boolean;
    /** The clinic requires a second factor and the account has none yet: it must enrol first. */
    mfaEnrollmentRequired?: boolean;
    professionalProfile?: {
      specialty: { id: string; code: string; name: string };
    };
  };
}
