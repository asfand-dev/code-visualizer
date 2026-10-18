const bcrypt = require('bcryptjs');
const { NotFoundError } = require('../utils/errors');

/** Business logic around users; the mongoose model is injected for testability. */
class UserService {
  constructor(model) {
    this.model = model;
  }

  async findAll(filter = {}) {
    return this.model.find(filter).lean();
  }

  async findById(id) {
    const user = await this.model.findById(id);
    if (!user) throw new NotFoundError(`User ${id} not found`);
    return user;
  }

  async create({ password, ...data }) {
    const passwordHash = await bcrypt.hash(password, 12);
    return this.model.create({ ...data, passwordHash });
  }

  async update(id, patch) {
    const user = await this.findById(id);
    Object.assign(user, patch);
    return user.save();
  }

  async remove(id) {
    const user = await this.findById(id);
    await user.deleteOne();
  }
}

module.exports = UserService;
