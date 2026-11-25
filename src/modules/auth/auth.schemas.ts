import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email('Invalid email').max(254);
/** E.164 sem espaços, ex.: +258841234567 */
export const phoneSchema = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number');
export const passwordSchema = z
  .string()
  .min(8, 'Password must have at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const registerBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  password: passwordSchema,
});

export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() }).optional();

export const forgotPasswordBody = z.object({ email: emailSchema });
export const resetPasswordBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const verifyEmailBody = z.object({ token: z.string().min(20).max(200) });
export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'New password must be different', path: ['newPassword'] });

export const sessionIdParams = z.object({ id: z.string().uuid() });

export type RegisterInput = z.infer<typeof registerBody>;
export type LoginInput = z.infer<typeof loginBody>;
