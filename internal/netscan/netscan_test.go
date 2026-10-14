package netscan

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func routes(rs []Route) []string {
	var out []string
	for _, r := range rs {
		out = append(out, strings.TrimSpace(r.Method+" "+r.Route))
	}
	sort.Strings(out)
	return out
}

func calls(cs []Call) []string {
	var out []string
	for _, c := range cs {
		out = append(out, strings.TrimSpace(c.Method+" "+c.URL))
	}
	sort.Strings(out)
	return out
}

func eq(t *testing.T, got, want []string) {
	t.Helper()
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestSpringJaxAsp(t *testing.T) {
	spring := `@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping("/{id}") public Order get() {}
    @PostMapping public Order create() {}
    @DeleteMapping(value = "/{id}/items") void rm() {}
}`
	eq(t, routes(Scan("A.java", []byte(spring), nil).Serves), []string{"DELETE /api/orders/{id}/items", "GET /api/orders/{id}", "POST /api/orders"})
	jax := `@Path("/users")
public class UserResource {
  @GET @Path("/me") public User me() {}
  @POST public void add() {}
}`
	eq(t, routes(Scan("U.java", []byte(jax), nil).Serves), []string{"GET /users/me", "POST /users"})
	asp := `[Route("api/[controller]")]
public class WidgetsController : ControllerBase {
  [HttpGet("{id}")] public IActionResult Get(int id) {}
  [HttpPost] public IActionResult Post() {}
}
app.MapGet("/healthz", () => "ok");`
	eq(t, routes(Scan("W.cs", []byte(asp), nil).Serves), []string{"GET /api/widgets/{id}", "GET /healthz", "POST /api/widgets"})
}

func TestJvmCalls(t *testing.T) {
	java := `class C {
  void f() {
    restTemplate.getForObject("http://orders:8080/api/orders", String.class);
    webClient.get().uri("http://users:3000/api/users/me");
  }
}`
	eq(t, calls(Scan("C.java", []byte(java), nil).Calls), []string{"GET http://orders:8080/api/orders", "http://users:3000/api/users/me"})
	cs := `var c = new HttpClient { BaseAddress = new Uri("http://billing:5000") };
var r = await c.GetAsync("/api/invoices/42");`
	eq(t, calls(Scan("B.cs", []byte(cs), nil).Calls), []string{"GET http://billing:5000/api/invoices/42", "http://billing:5000"})
}

func TestGrpc(t *testing.T) {
	goSrv := `pb.RegisterOrderServer(s, &srv{})`
	eq(t, routes(Scan("s.go", []byte(goSrv), nil).Serves), []string{"GRPC /grpc/Order"})
	goCli := `conn, _ := grpc.Dial("orders:50051", grpc.WithInsecure())
c := pb.NewOrderClient(conn)`
	eq(t, calls(Scan("c.go", []byte(goCli), nil).Calls), []string{"GRPC http://orders:50051/grpc/Order"})
	py := `channel = grpc.insecure_channel("billing:50051")
stub = billing_pb2_grpc.BillingStub(channel)`
	eq(t, calls(Scan("c.py", []byte(py), nil).Calls), []string{"GRPC http://billing:50051/grpc/Billing"})
}

func TestGraphQL(t *testing.T) {
	schema := "type Query {\n  users(first: Int): [User!]!\n  \"\"\"doc\"\"\"\n  me: User\n}\ntype Mutation { addUser(name: String!): User }\ntype User { id: ID! }\n"
	eq(t, routes(Scan("schema.graphql", []byte(schema), nil).Serves), []string{"GRAPHQL /graphql/Mutation.addUser", "GRAPHQL /graphql/Query.me", "GRAPHQL /graphql/Query.users"})
	js := "const Q = gql`query Load($n: Int) { users(first: $n) { id name } me { id } }`"
	eq(t, calls(Scan("q.ts", []byte(js), nil).Calls), []string{"GRAPHQL /graphql/Query.me", "GRAPHQL /graphql/Query.users"})
}

func TestWebSocketAndEnv(t *testing.T) {
	js := "const ws = new WebSocket('wss://feed:9000/stream')\nconst r = await fetch(`${process.env.ORDERS_URL}/api/orders`)\nfetch(process.env.USERS_SERVICE_URL + '/api/users')"
	env := Env(".env", []byte("ORDERS_URL=http://orders.internal:8080/\nOTHER=1\n"))
	eq(t, calls(Scan("a.ts", []byte(js), env).Calls), []string{"GET https://feed:9000/stream", "http://orders.internal:8080/api/orders", "http://users/api/users"})
	py := "requests.get(os.environ['BILLING_URL'] + '/api/invoices')\nrequests.post(f\"{os.getenv('MAIL_API_URL')}/send\")"
	eq(t, calls(Scan("a.py", []byte(py), nil).Calls), []string{"http://billing/api/invoices", "http://mail/send"})
	goSrc := `http.Get(fmt.Sprintf("%s/api/v1/items", os.Getenv("CATALOG_SERVICE_URL")))`
	eq(t, calls(Scan("a.go", []byte(goSrc), nil).Calls), []string{"http://catalog/api/v1/items"})
}

func TestEnvFilesAndAliases(t *testing.T) {
	compose := "services:\n  orders:\n    build: ./orders\n    environment:\n      - USERS_URL=http://users:3000\n      PAY_URL: http://payments:8000\n  users:\n    image: x\nvolumes:\n  data:\n"
	env := Env("docker-compose.yml", []byte(compose))
	if env["USERS_URL"] != "http://users:3000" || env["PAY_URL"] != "http://payments:8000" {
		t.Fatalf("env %v", env)
	}
	eq(t, Aliases("docker-compose.yml", []byte(compose)), []string{"orders", "users"})
	k8s := "apiVersion: v1\nkind: Service\nmetadata:\n  name: billing-svc\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\nspec:\n  template:\n    spec:\n      containers:\n        - env:\n            - name: AUTH_URL\n              value: http://auth:9000\n"
	eq(t, Aliases("deploy/k8s.yaml", []byte(k8s)), []string{"billing-svc"})
	if Env("deploy/k8s.yaml", []byte(k8s))["AUTH_URL"] != "http://auth:9000" {
		t.Fatal("k8s env not read")
	}
}

func TestOpenAPI(t *testing.T) {
	yaml := "openapi: 3.0.0\nservers:\n  - url: http://x/v1\npaths:\n  /pets:\n    get:\n      summary: x\n    post:\n      summary: y\n  /pets/{id}:\n    delete:\n      summary: z\ncomponents:\n  schemas:\n    A: {}\n"
	eq(t, routes(OpenAPI("openapi.yaml", []byte(yaml))), []string{"DELETE /v1/pets/{id}", "GET /v1/pets", "POST /v1/pets"})
	js := `{"openapi":"3.0.0","paths":{"/a":{"get":{},"parameters":[]}}}`
	eq(t, routes(OpenAPI("spec.json", []byte(js))), []string{"GET /a"})
}
