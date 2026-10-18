import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
// Auto-import picked the baseUrl-relative path; it resolves through tsconfig "baseUrl".
import { UsersRepository } from 'src/users/users.repository';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
