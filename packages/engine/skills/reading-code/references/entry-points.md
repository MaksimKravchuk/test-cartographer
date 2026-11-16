# Search patterns for entry points

Patterns for `search({ source, pattern })`. Each is a regular expression matched per line. Start with the
framework you identified from the file tree; if nothing matches, try the generic rows.

## Contents

- HTTP routes
- Scheduled jobs, queues, webhooks
- Entities and parameters
- States
- Who may do it
- Conditions and refusals

## HTTP routes

- Express, Fastify, Koa, Hono: `\b(app|router|server|api)\.(get|post|put|patch|delete)\(`
- NestJS: `@(Get|Post|Put|Patch|Delete)\(`
- Next.js: no pattern — list `files()` under `app/` or `pages/api/` and look for `route.` and `page.` files
- Django: `\b(path|re_path)\(` and `class \w+\((\w+\.)?\w*(ViewSet|APIView|View)\)`
- Flask, FastAPI: `@\w+\.(route|get|post|put|patch|delete)\(`
- Rails: `^\s*(resources?|get|post|put|patch|delete|namespace)\s` with `dir` set to `config`
- Laravel: `Route::(get|post|put|patch|delete|resource|apiResource)\(`
- Spring: `@(Get|Post|Put|Patch|Delete|Request)Mapping`
- ASP.NET: `\[Http(Get|Post|Put|Patch|Delete)` and `\.Map(Get|Post|Put|Patch|Delete)\(`
- Go: `\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\(`
- GraphQL: `^\s*(type|extend type) (Query|Mutation)` and `@(Query|Mutation|Resolver)\(`
- Generic: `['"]/(api/)?[a-z-]+(/:?\w+)*['"]`

## Scheduled jobs, queues, webhooks

- Cron in any stack: `cron|@Scheduled|@Cron\(|schedule\.every|crontab|setInterval\(`
- Celery, Sidekiq, Active Job: `@(shared_task|app\.task)|include Sidekiq|< ApplicationJob|perform_(later|async)`
- BullMQ, Bull, Agenda: `new (Worker|Queue)\(|\.process\(|agenda\.define\(`
- Message consumers: `@(EventPattern|MessagePattern|KafkaListener|RabbitListener|SqsListener)|\.subscribe\(|consumer\.run\(`
- Webhooks: `webhook`

## Entities and parameters

- Django: `class \w+\((\w+\.)?Model\)`
- Rails: `< (ApplicationRecord|ActiveRecord::Base)` and `create_table`
- TypeORM, JPA, Entity Framework: `@Entity|@Table\(|: DbContext|DbSet<`
- Prisma: `^model \w+ \{` in files named `schema.prisma`
- Sequelize, Mongoose: `sequelize\.define\(|extends Model|new (mongoose\.)?Schema\(`
- SQLAlchemy, Pydantic: `\(Base\)|\(db\.Model\)|\(BaseModel\)`
- Go: `gorm\.Model|type \w+ struct`
- Migrations and SQL: `CREATE TABLE|add_column|addColumn|ALTER TABLE`
- API schemas: list `files()` for `openapi`, `swagger`, `.graphql`, `.proto`

## States

- Status enums: `enum \w*(Status|State)|(Status|State)\s*=\s*\[|TextChoices|IntegerChoices|aasm|state_machine`
- Comparisons that reveal values: `\.(status|state)\s*(===?|!==?|!=)\s*['"\w]`
- Hidden states: `\w+_at\b.*(null|None|nil|\?)|\bis_\w+|deleted_at|archived`

## Who may do it

- Decorators and annotations: `@(PreAuthorize|Secured|RolesAllowed|Roles|UseGuards|login_required|permission_required)|permission_classes|\[Authorize`
- Calls: `\b(hasRole|has_role|requireRole|authorize|can\?|can\(|ability|isAdmin|is_admin|is_staff|policy)\b`
- Rails and Laravel filters: `before_action|middleware\(`

## Conditions and refusals

- Refusals: `raise \w|throw new|abort\(|ValidationError|HttpException|status\(4\d\d\)|Forbidden|Unprocessable`
- Limits and deadlines: `\b(MAX|MIN|LIMIT|TIMEOUT|EXPIR|TTL)\w*|timedelta\(|\.days|hours\(`
