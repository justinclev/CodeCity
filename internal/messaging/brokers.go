package messaging

import (
	"regexp"
	"strings"
)

// Other brokers: first-argument call patterns, applied to every supported language
// once the file mentions the broker.

const ctxArg = `(?:(?:ctx|context\.Background\(\)|context\.TODO\(\))\s*,\s*)?`

type rule struct {
	re   *regexp.Regexp
	dir  string
	grp  int  // group holding the topic (or list)
	list bool // the group is a comma-separated list
}

type broker struct {
	name    string
	markers []string
	rules   []rule
}

func r(dir, pat string, grp int, list bool) rule {
	return rule{regexp.MustCompile(pat), dir, grp, list}
}

var brokers = []broker{
	{"nats", []string{"nats"}, []rule{
		r(Pub, `\.(?:Publish|PublishMsg|PublishAsync|Request|publish|request)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Subscribe|QueueSubscribe|SubscribeSync|QueueSubscribeSync|ChanSubscribe|subscribe)\(\s*(`+expr+`)`, 1, false),
	}},
	{"redis", []string{"redis"}, []rule{
		r(Pub, `\.(?:Publish|publish)\(\s*`+ctxArg+`(`+expr+`)\s*,`, 1, false),
		r(Sub, `\.(?:Subscribe|PSubscribe|subscribe|psubscribe)\(\s*`+ctxArg+`(`+expr+`)`, 1, false),
	}},
	{"mqtt", []string{"mqtt"}, []rule{
		r(Pub, `\.(?:Publish|publish)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Subscribe|subscribe)\(\s*(`+expr+`)`, 1, false),
	}},
	{"amqp", []string{"amqp", "rabbitmq", "pika"}, []rule{
		r(Pub, `\.(?:Publish|PublishWithContext)\(\s*`+ctxArg+`(?:`+expr+`)\s*,\s*(`+expr+`)`, 1, false),
		r(Pub, `\bsendToQueue\(\s*(`+expr+`)`, 1, false),
		r(Pub, `basic_publish\([^)]*routing_key\s*=\s*(`+expr+`)`, 1, false),
		r(Sub, `\.(?:Consume|consume)\(\s*(`+expr+`)`, 1, false),
		r(Sub, `basic_consume\([^)]*queue\s*=\s*(`+expr+`)`, 1, false),
	}},
}

var sqsRe = regexp.MustCompile(`\b(QueueUrl|TopicArn)\b["']?\s*[:=]\s*(` + expr + `)`)

// others scans for NATS, Redis, MQTT, AMQP (RabbitMQ), SQS and SNS.
func (s *scanner) others(path, lower string) {
	if !isJS(path) && !strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".py") && !strings.HasSuffix(path, ".rs") {
		return
	}
	for _, b := range brokers {
		found := false
		for _, m := range b.markers {
			if strings.Contains(lower, m) {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		s.broker = b.name
		for _, ru := range b.rules {
			for _, m := range ru.re.FindAllSubmatchIndex(s.src, -1) {
				if ru.grp*2+1 >= len(m) || m[2*ru.grp] < 0 {
					continue
				}
				v, off := string(s.src[m[2*ru.grp]:m[2*ru.grp+1]]), m[2*ru.grp]
				if ru.list {
					s.list(v, off, ru.dir)
				} else {
					s.add(ru.dir, v, off)
				}
			}
		}
	}
	if strings.Contains(lower, "sqs") || strings.Contains(lower, "sns") || strings.Contains(lower, "queueurl") || strings.Contains(lower, "topicarn") {
		for _, m := range sqsRe.FindAllSubmatchIndex(s.src, -1) {
			key, v, off := string(s.src[m[2]:m[3]]), string(s.src[m[4]:m[5]]), m[4]
			val := resolve(v, s.consts)
			if val == "" {
				continue
			}
			// the queue / topic is named by the last segment of the URL or ARN
			name := val[strings.LastIndexAny(val, "/:")+1:]
			ctx := strings.ToLower(string(s.src[max(0, m[0]-300):m[0]]))
			dir := Pub
			if i, j := strings.LastIndex(ctx, "receive"), strings.LastIndex(ctx, "send"); i > j || strings.LastIndex(ctx, "consume") > j {
				dir = Sub
			}
			s.broker = "sqs"
			if key == "TopicArn" {
				s.broker = "sns"
			}
			s.add(dir, `"`+name+`"`, off)
		}
	}
}

// ---- Java, Kotlin and C#

var (
	jKafkaListener = regexp.MustCompile(`@KafkaListener\(([^)]*)\)`)
	jRabbitListen  = regexp.MustCompile(`@RabbitListener\(([^)]*)\)`)
	jSqsListener   = regexp.MustCompile(`@SqsListener\(\s*(?:(?:value|queueNames?)\s*=\s*)?(\{[^}]*\}|\[[^\]]*\]|` + expr + `)`)
	jJmsListener   = regexp.MustCompile(`@JmsListener\([^)]*destination\s*=\s*(` + expr + `)`)
	jListAttr      = regexp.MustCompile(`(?:topics|queues)\s*=\s*(\{[^}]*\}|\[[^\]]*\]|` + expr + `)`)
	jKafkaSend     = regexp.MustCompile(`(?:kafkaTemplate|KafkaTemplate)\.(?:send|sendDefault)\(\s*(` + expr + `)`)
	jProducerRec   = regexp.MustCompile(`ProducerRecord(?:<[^>]*>)?\(\s*(` + expr + `)`)
	jSendTo        = regexp.MustCompile(`@SendTo\(\s*(` + expr + `)`)
	jSubscribe     = regexp.MustCompile(`\.subscribe\(\s*(?:Arrays\.asList|List\.of|Collections\.singletonList|listOf|setOf|Set\.of|arrayListOf)\(([^)]*)\)`)
	jRabbitSend    = regexp.MustCompile(`rabbitTemplate\.(?:convertAndSend|send)\(\s*(` + expr + `)\s*(?:,\s*(` + expr + `)\s*,)?`)
	jBasicPublish  = regexp.MustCompile(`basicPublish\(\s*` + expr + `\s*,\s*(` + expr + `)`)
	jBasicConsume  = regexp.MustCompile(`basicConsume\(\s*(` + expr + `)`)
	jJmsSend       = regexp.MustCompile(`(?:jmsTemplate|queueMessagingTemplate|sqsTemplate)\.(?:convertAndSend|send)\(\s*(` + expr + `)`)
	csProduce      = regexp.MustCompile(`\.Produce(?:Async)?\(\s*(` + expr + `)`)
	csSubscribe    = regexp.MustCompile(`\.Subscribe\(\s*(?:new\s*(?:\[\]|List<string>)\s*\{([^}]*)\}|(` + expr + `))\s*\)`)
	csBasicPublish = regexp.MustCompile(`BasicPublish\([^)]*routingKey\s*:\s*(` + expr + `)`)
	csBasicConsume = regexp.MustCompile(`BasicConsume\([^)]*queue\s*:\s*(` + expr + `)`)
	csSender       = regexp.MustCompile(`\.CreateSender\(\s*(` + expr + `)`)
	csProcessor    = regexp.MustCompile(`\.CreateProcessor\(\s*(` + expr + `)`)
)

func (s *scanner) items(v string, dir string, off int) {
	v = strings.Trim(strings.TrimSpace(v), "{}[]")
	s.list(v, off, dir)
}

func (s *scanner) group(re *regexp.Regexp, g int, dir string, list bool) {
	for _, m := range re.FindAllSubmatchIndex(s.src, -1) {
		if 2*g+1 >= len(m) || m[2*g] < 0 {
			continue
		}
		v, off := string(s.src[m[2*g]:m[2*g+1]]), m[2*g]
		if list {
			s.items(v, dir, off)
		} else {
			s.add(dir, v, off)
		}
	}
}

// attr applies a listener annotation: the arguments are searched for a topics / queues attribute.
func (s *scanner) attr(re *regexp.Regexp, dir string) {
	for _, m := range re.FindAllSubmatchIndex(s.src, -1) {
		args := string(s.src[m[2]:m[3]])
		if a := jListAttr.FindStringSubmatchIndex(args); a != nil {
			s.items(args[a[2]:a[3]], dir, m[2]+a[2])
		}
	}
}

func (s *scanner) jvm(path, lower string) {
	kt := strings.HasSuffix(path, ".java") || strings.HasSuffix(path, ".kt") || strings.HasSuffix(path, ".kts")
	if kt {
		if strings.Contains(lower, "kafka") {
			s.broker = "kafka"
			s.attr(jKafkaListener, Sub)
			s.group(jKafkaSend, 1, Pub, false)
			s.group(jProducerRec, 1, Pub, false)
			s.group(jSendTo, 1, Pub, false)
			s.group(jSubscribe, 1, Sub, true)
		}
		if strings.Contains(lower, "rabbit") || strings.Contains(lower, "amqp") {
			s.broker = "amqp"
			s.attr(jRabbitListen, Sub)
			for _, m := range jRabbitSend.FindAllSubmatchIndex(s.src, -1) {
				g := 1
				if m[4] >= 0 {
					g = 2
				}
				s.add(Pub, string(s.src[m[2*g]:m[2*g+1]]), m[2*g])
			}
			s.group(jBasicPublish, 1, Pub, false)
			s.group(jBasicConsume, 1, Sub, false)
		}
		if strings.Contains(lower, "sqs") {
			s.broker = "sqs"
			s.group(jSqsListener, 1, Sub, true)
			s.group(jJmsSend, 1, Pub, false)
		}
		if strings.Contains(lower, "jms") {
			s.broker = "jms"
			s.group(jJmsListener, 1, Sub, false)
			s.group(jJmsSend, 1, Pub, false)
		}
	}
	if strings.HasSuffix(path, ".cs") {
		if strings.Contains(lower, "kafka") {
			s.broker = "kafka"
			s.group(csProduce, 1, Pub, false)
			s.group(csSubscribe, 1, Sub, true)
			s.group(csSubscribe, 2, Sub, false)
		}
		if strings.Contains(lower, "rabbitmq") {
			s.broker = "amqp"
			s.group(csBasicPublish, 1, Pub, false)
			s.group(csBasicConsume, 1, Sub, false)
		}
		if strings.Contains(lower, "servicebus") {
			s.broker = "servicebus"
			s.group(csSender, 1, Pub, false)
			s.group(csProcessor, 1, Sub, false)
		}
	}
}
